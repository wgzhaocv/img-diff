//! libvips による正規化デコード（SPEC §1 手順 1〜3）。
//! 壊れた高レベルバインディング（windows-gnu で型不整合）を避け、必要な libvips C 関数だけを
//! 自前で extern "C" 宣言して呼ぶ。手順 4 以降（白平坦化・リサイズ・ハッシュ）は core が行う。
//!
//! 出力は **straight-alpha の sRGB RGBA バイト**（width*height*4）。白平坦化はまだ行わない
//! （呼び出し側が `imgdiff_core::preprocess::flatten_on_white` を適用してから core に渡す）。

use crate::error::CliError;
use anyhow::Result;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

/// libvips の enum 値（vips/enumtypes.h）。
const VIPS_INTERPRETATION_SRGB: c_int = 22;
const VIPS_FORMAT_UCHAR: c_int = 0;

/// VipsImage は不透明な GObject。ポインタとしてのみ扱う。
#[repr(C)]
struct VipsImage {
    _private: [u8; 0],
}

// libvips（可変長引数は NULL 終端のオプション列。ここでは常にオプション無し＝ NULL のみ）。
unsafe extern "C" {
    fn vips_init(argv0: *const c_char) -> c_int;
    fn vips_concurrency_set(concurrency: c_int);
    fn vips_error_buffer() -> *const c_char;
    fn vips_error_clear();
    fn vips_image_new_from_file(name: *const c_char, ...) -> *mut VipsImage;
    fn vips_autorot(inp: *mut VipsImage, out: *mut *mut VipsImage, ...) -> c_int;
    fn vips_colourspace(inp: *mut VipsImage, out: *mut *mut VipsImage, space: c_int, ...) -> c_int;
    fn vips_addalpha(inp: *mut VipsImage, out: *mut *mut VipsImage, ...) -> c_int;
    fn vips_cast(inp: *mut VipsImage, out: *mut *mut VipsImage, format: c_int, ...) -> c_int;
    fn vips_image_get_width(image: *const VipsImage) -> c_int;
    fn vips_image_get_height(image: *const VipsImage) -> c_int;
    fn vips_image_get_bands(image: *const VipsImage) -> c_int;
    fn vips_image_write_to_memory(inp: *mut VipsImage, size: *mut usize) -> *mut c_void;
    /// flag: 0=major, 1=minor, 2=micro。
    fn vips_version(flag: c_int) -> c_int;
}

/// glib のログコールバック型。
type GLogFunc = unsafe extern "C" fn(*const c_char, c_int, *const c_char, *mut c_void);

// glib（vips.pc が要求するためリンク済み）。
unsafe extern "C" {
    fn g_object_unref(object: *mut c_void);
    fn g_free(mem: *mut c_void);
    fn g_log_set_handler(
        domain: *const c_char,
        levels: c_int,
        func: GLogFunc,
        user_data: *mut c_void,
    ) -> u32;
}

/// 何もしないログハンドラ。VIPS の任意モジュール読み込み失敗の警告を黙らせる。
unsafe extern "C" fn silent_log(_d: *const c_char, _l: c_int, _m: *const c_char, _u: *mut c_void) {}

/// libvips のバージョン文字列（例 "8.18.3"）。Producer.vips に入れる。
pub fn vips_version_string() -> String {
    unsafe {
        format!(
            "{}.{}.{}",
            vips_version(0),
            vips_version(1),
            vips_version(2)
        )
    }
}

static INIT: Once = Once::new();
static INIT_OK: AtomicBool = AtomicBool::new(false);

/// libvips を 1 度だけ初期化する。vips 内部スレッドは 1（並列はファイル単位に rayon で行う）。
/// 失敗時は以後のデコードがエラーになる。main から起動時に呼ぶ。
pub fn init() -> Result<()> {
    INIT.call_once(|| {
        // 任意モジュール(heif/jxl 等)読み込み失敗の VIPS-WARNING は vips_init **中**に出る。
        // 初期化前にハンドラを設定して黙らせる。16|32|64|128 = WARNING|MESSAGE|INFO|DEBUG。
        unsafe {
            g_log_set_handler(
                c"VIPS".as_ptr(),
                16 | 32 | 64 | 128,
                silent_log,
                std::ptr::null_mut(),
            );
        }
        let argv0 = CString::new("imgdiff").unwrap();
        let ok = unsafe { vips_init(argv0.as_ptr()) == 0 };
        if ok {
            unsafe { vips_concurrency_set(1) };
        }
        INIT_OK.store(ok, Ordering::SeqCst);
    });
    if INIT_OK.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err(CliError::new(
            "decode_error",
            "libvips の初期化に失敗しました（libvips ランタイムが見つかりません: 同梱 DLL を実行ファイルと同じ場所に置くか PATH に通してください）",
        )
        .into())
    }
}

/// デコード結果（白平坦化前の sRGB RGBA）。
pub struct Decoded {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// vips のエラーバッファを読み、CliError(decode_error) に変換してクリアする。
unsafe fn vips_error(ctx: &str) -> anyhow::Error {
    let buf = unsafe { vips_error_buffer() };
    let msg = if buf.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(buf) }
            .to_string_lossy()
            .into_owned()
    };
    unsafe { vips_error_clear() };
    // load 失敗は入力ファイル起因が大半 → 次アクションを添える（AI が自己修正できるように）。
    let hint = if ctx == "load" {
        "（対応形式か・ファイルが壊れていないか確認してください。HEIC/AVIF 等は未対応の場合あり）"
    } else {
        ""
    };
    CliError::new("decode_error", format!("{ctx}: {}{hint}", msg.trim())).into()
}

/// 1 ステップの vips 演算（in → out）を実行し、成功なら in を unref して out を返す。
/// 失敗なら in を unref してエラー。
unsafe fn step(
    inp: *mut VipsImage,
    ctx: &str,
    op: impl FnOnce(*mut VipsImage, *mut *mut VipsImage) -> c_int,
) -> Result<*mut VipsImage> {
    let mut out: *mut VipsImage = std::ptr::null_mut();
    let rc = op(inp, &mut out);
    unsafe { g_object_unref(inp as *mut c_void) };
    if rc != 0 || out.is_null() {
        return Err(unsafe { vips_error(ctx) });
    }
    Ok(out)
}

/// ファイルを sRGB RGBA（straight alpha・uchar・4band）にデコードする。SPEC §1 手順 1〜3。
pub fn decode_canonical(path: &Path) -> Result<Decoded> {
    let path_str = path
        .to_str()
        .ok_or_else(|| CliError::new("decode_error", "パスが UTF-8 ではありません"))?;
    let cpath = CString::new(path_str)
        .map_err(|_| CliError::new("decode_error", "パスに NUL が含まれます"))?;
    let null = std::ptr::null::<c_void>();

    unsafe {
        // 1. ロード
        let loaded = vips_image_new_from_file(cpath.as_ptr(), null);
        if loaded.is_null() {
            return Err(vips_error("load"));
        }
        // 2. autorotate（EXIF Orientation）
        let rotated = step(loaded, "autorot", |i, o| vips_autorot(i, o, null))?;
        // 3. sRGB へ変換
        let srgb = step(rotated, "colourspace", |i, o| {
            vips_colourspace(i, o, VIPS_INTERPRETATION_SRGB, null)
        })?;

        // 4band(RGBA) を保証する。sRGB 変換後は通常 3(不透明) か 4(alpha あり)。
        let bands = vips_image_get_bands(srgb);
        let rgba_img = match bands {
            4 => srgb,
            3 => step(srgb, "addalpha", |i, o| vips_addalpha(i, o, null))?,
            other => {
                g_object_unref(srgb as *mut c_void);
                return Err(CliError::new(
                    "decode_error",
                    format!("想定外のバンド数 {other}（RGB/RGBA のみ対応）"),
                )
                .into());
            }
        };
        // uchar(8bit) にキャスト
        let casted = step(rgba_img, "cast", |i, o| {
            vips_cast(i, o, VIPS_FORMAT_UCHAR, null)
        })?;

        let width = vips_image_get_width(casted) as u32;
        let height = vips_image_get_height(casted) as u32;

        // メモリへ書き出し（band-interleaved = RGBA バイト、行優先）。
        let mut size: usize = 0;
        let buf = vips_image_write_to_memory(casted, &mut size);
        if buf.is_null() {
            g_object_unref(casted as *mut c_void);
            return Err(vips_error("write_to_memory"));
        }
        let rgba = std::slice::from_raw_parts(buf as *const u8, size).to_vec();
        g_free(buf);
        g_object_unref(casted as *mut c_void);

        let expected = width as usize * height as usize * 4;
        if rgba.len() != expected {
            return Err(CliError::new(
                "decode_error",
                format!("バッファ長 {} != 期待 {expected}", rgba.len()),
            )
            .into());
        }
        Ok(Decoded {
            rgba,
            width,
            height,
        })
    }
}
