//! core を web（WebAssembly）向けに公開する薄いラッパ。
//! wasm-vips がデコード（+autorotate/sRGB, SPEC §1 手順 1〜3）した RGBA を受け取り、
//! core が手順 4〜8（白平坦化・9x8 リサイズ・グレー・dHash）と compare/cluster を行う。
//! ロジックの正本は `packages/schema/SPEC.md`。CLI（原生 libvips）と同じ core を共有し、
//! native と wasm で**同一結果**になることを `parity` テストで保証する。

use imgdiff_core::report::{DupGroup, ImageRecord, Strictness};
use imgdiff_core::{cluster, compare, diff, hash, preprocess};
use wasm_bindgen::prelude::*;

pub use imgdiff_core as core;

// ---- scan（索引）向け -------------------------------------------------------

/// wasm-vips がデコードした RGBA（sRGB・autorotate 済）を**その場で白平坦化**し、
/// 9x8 dHash を 16進16文字で返す。`rgba` は破壊的に平坦化されて JS 側へ書き戻る。SPEC §1 手順 4〜8。
///
/// 注意（DESIGN §2.1 の二段パス）: 書き戻った平坦化 RGBA を pixelSha256（crypto.subtle）に
/// 流用できるのは**全分解能デコード時のみ**。shrink-on-load（dHash 用に 9x8 相当へ縮小デコード）
/// では返るバイトは pixelSha256 の対象ではない。その場合は 1 パス目に `dhash_hex`（書き戻し無し）を、
/// 2 パス目（衝突バケットのみ再デコード）に `flatten_on_white` を使う。呼び分けは JS オーケストレータ側。
#[wasm_bindgen]
pub fn flatten_and_dhash(rgba: &mut [u8], width: u32, height: u32) -> String {
    preprocess::flatten_on_white(rgba);
    hash::to_hex(hash::dhash_rgba(rgba, width, height))
}

/// RGBA を背景白で平坦化する（in-place・alpha=255 化）。SPEC §1 手順 4。
#[wasm_bindgen]
pub fn flatten_on_white(rgba: &mut [u8]) {
    preprocess::flatten_on_white(rgba);
}

/// 白平坦化済み RGBA から 9x8 dHash（16進16文字）を計算する。SPEC §1 手順 5〜8。
#[wasm_bindgen]
pub fn dhash_hex(rgba: &[u8], width: u32, height: u32) -> String {
    hash::to_hex(hash::dhash_rgba(rgba, width, height))
}

/// 2 つの dHash（16進16文字）のハミング距離 0..=64。不正な hex は None（= undefined）。
#[wasm_bindgen]
pub fn hamming_hex(a: &str, b: &str) -> Option<u32> {
    Some(hash::hamming(hash::from_hex(a)?, hash::from_hex(b)?))
}

// ---- compare（2 枚比較）向け ------------------------------------------------

/// compare の連続値スコア（SPEC §3）。比較不能（寸法不一致）時は呼ばない前提。
/// `pixel_equal` と `hamming_distance` はここに含めない: 前者は JS が pixelSha256
/// （両画像の crypto.subtle）の一致で、後者は `hamming_hex` で導出する（いずれも CLI
/// `compare.rs`（pixel_sha256 一致 / hash::hamming）と同じ意味に揃える）。
#[wasm_bindgen]
pub struct CompareScores {
    pixel_diff_ratio: f64,
    ssim: f64,
    psnr: f64,
}

#[wasm_bindgen]
impl CompareScores {
    #[wasm_bindgen(getter)]
    pub fn pixel_diff_ratio(&self) -> f64 {
        self.pixel_diff_ratio
    }
    #[wasm_bindgen(getter)]
    pub fn ssim(&self) -> f64 {
        self.ssim
    }
    #[wasm_bindgen(getter)]
    pub fn psnr(&self) -> f64 {
        self.psnr
    }
}

/// 白平坦化済み・同寸法の RGBA 2 枚から連続値スコアをまとめて計算する（境界越えを 1 回に集約）。
/// SSIM は内部で Rec.601 グレー化してから計算する。SPEC §3。
#[wasm_bindgen]
pub fn compare_scores(a: &[u8], b: &[u8], width: u32, height: u32, tolerance: u8) -> CompareScores {
    let ga = preprocess::to_gray_rec601(a);
    let gb = preprocess::to_gray_rec601(b);
    CompareScores {
        pixel_diff_ratio: compare::pixel_diff_ratio(a, b, tolerance),
        ssim: compare::ssim(&ga, &gb, width, height),
        psnr: compare::psnr(a, b),
    }
}

/// 白平坦化済み・同寸法の RGBA 2 枚から差分ハイライト RGBA を返す（SPEC §4）。
/// 品紅=差分・淡グレー=ベース。可視化専用。
#[wasm_bindgen]
pub fn diff_highlight(a: &[u8], b: &[u8], tolerance: u8) -> Vec<u8> {
    diff::highlight(a, b, tolerance)
}

// ---- clustering（グループ化）------------------------------------------------

/// 索引済み画像（`ImageRecord[]`）を厳密度でグループ化し `DupGroup[]` を返す。SPEC §5。
/// `strictness` は "exact" | "pixel" | "perceptual"。`threshold` は perceptual のみ有効（None で既定 10）。
#[wasm_bindgen]
pub fn cluster_group(
    images: JsValue,
    strictness: &str,
    threshold: Option<u32>,
) -> Result<JsValue, JsValue> {
    let images: Vec<ImageRecord> = serde_wasm_bindgen::from_value(images)
        .map_err(|e| JsValue::from_str(&format!("images の解析に失敗: {e}")))?;
    let strictness = parse_strictness(strictness)?;
    let groups: Vec<DupGroup> = cluster::group(&images, strictness, threshold);
    serde_wasm_bindgen::to_value(&groups)
        .map_err(|e| JsValue::from_str(&format!("groups の直列化に失敗: {e}")))
}

fn parse_strictness(s: &str) -> Result<Strictness, JsValue> {
    match s {
        "exact" => Ok(Strictness::Exact),
        "pixel" => Ok(Strictness::Pixel),
        "perceptual" => Ok(Strictness::Perceptual),
        other => Err(JsValue::from_str(&format!(
            "未知の strictness: {other}（exact|pixel|perceptual）"
        ))),
    }
}

// ---- parity（native == wasm の同一性検証）-----------------------------------
//
// SPEC §1 が要求する golden 夹具。合成 RGBA を決定的に生成し、dHash と compare 各スコアを
// 計算して既知値（GOLDEN）と突き合わせる。native（`cargo test`）と wasm32
// （`wasm-pack test --node`）の**両方**で同じ GOLDEN に一致すれば、共有 core が
// 両端でビット一致することの証明になる（`image` の f32 リサイズ・f64 累積の両端一致）。

/// 単体 fixture（name, RGBA, width, height）。
#[cfg(test)]
type Fixture = (&'static str, Vec<u8>, u32, u32);
/// compare ペア（name, RGBA a, RGBA b, width, height）。
#[cfg(test)]
type ComparePair = (&'static str, Vec<u8>, Vec<u8>, u32, u32);

/// 決定的な合成 RGBA 画像（アスペクト無視の各種サイズ・パターン）。
/// 9x8 の倍数でないサイズを混ぜ、リサイズ補間（f32）を実際に走らせる。
#[cfg(test)]
fn fixtures() -> Vec<Fixture> {
    // 決定的擬似ノイズ（LCG）。写真風の非自明なパターンを作る。
    fn lcg(mut s: u32) -> impl FnMut() -> u8 {
        move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s >> 24) as u8
        }
    }
    // name/w/h と 1 画素生成関数から fixture タプルを作る（w,h の二重指定を避ける）。行優先。
    fn fx(name: &'static str, w: u32, h: u32, mut f: impl FnMut(u32, u32) -> [u8; 4]) -> Fixture {
        let mut v = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                v[i..i + 4].copy_from_slice(&f(x, y));
            }
        }
        (name, v, w, h)
    }
    let mut noise = lcg(0x9E37_79B9);
    vec![
        // 対角グラデ（補間が効く・非 9x8 倍数）
        fx("diag-100x77", 100, 77, |x, y| {
            let v = ((x + y) * 255 / (100 + 77 - 2)) as u8;
            [v, v.wrapping_add(40), 255u8.wrapping_sub(v), 200]
        }),
        // 放射状（中心から距離）
        fx("radial-63x63", 63, 63, |x, y| {
            let dx = x as i32 - 31;
            let dy = y as i32 - 31;
            let d = ((dx * dx + dy * dy) as f64).sqrt();
            let v = (d * 5.0).min(255.0) as u8;
            [v, 128, 255u8.wrapping_sub(v), 255]
        }),
        // 正弦リプル（横）
        fx("ripple-128x40", 128, 40, |x, _y| {
            let v = (((x as f64 * 0.3).sin() * 0.5 + 0.5) * 255.0) as u8;
            [v, v, v, 255]
        }),
        // 市松（縮小で灰色に潰れる境界）
        fx("checker-90x80", 90, 80, |x, y| {
            let on = ((x / 7) + (y / 7)) % 2 == 0;
            let v = if on { 230 } else { 25 };
            [v, v, v, 255]
        }),
        // 擬似ノイズ（半透明含む → 白平坦化を経由）
        fx("noise-70x50", 70, 50, |_x, _y| [noise(), noise(), noise(), noise()]),
        // 9x8 と一致（リサイズ恒等）
        fx("exact-9x8", 9, 8, |x, y| {
            let v = ((x * 8 + y) * 3) as u8;
            [v, v, v, 255]
        }),
    ]
}

/// 同寸法の compare ペア（pixel_diff_ratio / ssim / psnr の両端一致を見る・f64 累積）。
#[cfg(test)]
fn compare_pairs() -> Vec<ComparePair> {
    let w = 64u32;
    let h = 48u32;
    let base: Vec<u8> = {
        let mut v = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let g = ((x * 4 + y * 3) % 256) as u8;
                v[i..i + 4].copy_from_slice(&[g, g.wrapping_add(17), g.wrapping_add(90), 255]);
            }
        }
        v
    };
    // 少しずらした版（数画素だけ差）
    let mut shifted = base.clone();
    for p in (0..(w * h) as usize).step_by(37) {
        shifted[p * 4] = shifted[p * 4].wrapping_add(23);
        shifted[p * 4 + 2] = shifted[p * 4 + 2].wrapping_sub(11);
    }
    // 全画素反転（RGB のみ・alpha=255）。SSIM の負→0 clamp と低 PSNR の両端一致も golden で押さえる。
    let inverted: Vec<u8> = base
        .iter()
        .enumerate()
        .map(|(i, &v)| if i % 4 == 3 { 255 } else { 255 - v })
        .collect();
    vec![
        ("same", base.clone(), base.clone(), w, h),
        ("shifted", base.clone(), shifted, w, h),
        ("inverted", base, inverted, w, h),
    ]
}

/// 全 fixture の検証ベクトル（決定的な文字列列）。float は `to_bits` の 16進でビット厳密比較する。
#[cfg(test)]
fn parity_vectors() -> Vec<String> {
    // float はビット厳密比較（to_bits の16進）。バイト列は 31 進 rolling fold で要約。
    fn bits(x: f64) -> String {
        format!("{:016x}", x.to_bits())
    }
    fn fold(bytes: &[u8]) -> String {
        let acc = bytes
            .iter()
            .fold(0u32, |a, &b| a.wrapping_mul(31).wrapping_add(b as u32));
        format!("{acc:08x}")
    }
    let mut out = Vec::new();
    for (name, rgba, w, h) in fixtures() {
        let mut f = rgba.clone();
        preprocess::flatten_on_white(&mut f);
        out.push(format!("dhash {name} {}", hash::to_hex(hash::dhash_rgba(&f, w, h))));
        // 白平坦化後 RGBA の畳み込みも見る（flatten の両端一致）。
        out.push(format!("flat {name} {}", fold(&f)));
    }
    for (name, a, b, w, h) in compare_pairs() {
        let (mut fa, mut fb) = (a.clone(), b.clone());
        preprocess::flatten_on_white(&mut fa);
        preprocess::flatten_on_white(&mut fb);
        let ga = preprocess::to_gray_rec601(&fa);
        let gb = preprocess::to_gray_rec601(&fb);
        out.push(format!("pdr {name} {}", bits(compare::pixel_diff_ratio(&fa, &fb, 0))));
        out.push(format!("ssim {name} {}", bits(compare::ssim(&ga, &gb, w, h))));
        out.push(format!("psnr {name} {}", bits(compare::psnr(&fa, &fb))));
        out.push(format!("diff {name} {}", fold(&diff::highlight(&fa, &fb, 0))));
    }
    out
}

/// GOLDEN: native の初回実行で確定した既知値。native/wasm 双方がこれに一致すること。
/// （`cargo test -p imgdiff-wasm print_parity_vectors -- --nocapture --ignored` で採取して埋める）
#[cfg(test)]
const GOLDEN: &[&str] = &[
    "dhash diag-100x77 fffffffffffefcf8",
    "flat diag-100x77 b4dbf87e",
    "dhash radial-63x63 0f0f0f0f0f0f0f0f",
    "flat radial-63x63 29e25660",
    "dhash ripple-128x40 2424242424242424",
    "flat ripple-128x40 0d41c250",
    "dhash checker-90x80 3232c80032c8cc32",
    "flat checker-90x80 d0b76c54",
    "dhash noise-70x50 a5a72d05a9bd69d9",
    "flat noise-70x50 4fb12c38",
    "dhash exact-9x8 ffffffffffffffff",
    "flat exact-9x8 44dde0c4",
    "pdr same 0000000000000000",
    "ssim same 3ff0000000000000",
    "psnr same 4059000000000000",
    "diff same 7dbcbac0",
    "pdr shifted 3f9c000000000000",
    "ssim shifted 3fefa20f3bbc5724",
    "psnr shifted 403d8d4ed840525e",
    "diff shifted fcdcf159",
    "pdr inverted 3ff0000000000000",
    "ssim inverted 0000000000000000",
    "psnr inverted 4012f2fa5882a58f",
    "diff inverted 70710c00",
];

/// GOLDEN との照合（native/wasm 双子テストで共有）。
#[cfg(test)]
fn assert_parity() {
    assert_eq!(parity_vectors(), GOLDEN);
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod native_tests {
    use super::*;

    /// GOLDEN 採取用（既定は ignored）。`-- --ignored --nocapture` で値を印字する。
    #[test]
    #[ignore]
    fn print_parity_vectors() {
        for v in parity_vectors() {
            println!("{v}");
        }
    }

    /// native で GOLDEN に一致すること（回帰防止 + wasm 側と同じ基準）。
    #[test]
    fn parity_matches_golden() {
        assert_parity();
    }
}

#[cfg(all(test, target_arch = "wasm32"))]
mod wasm_tests {
    use super::*;
    use wasm_bindgen_test::*;

    /// wasm32 でも同じ GOLDEN に一致すること（= native == wasm のビット一致証明）。
    #[wasm_bindgen_test]
    fn parity_matches_golden() {
        assert_parity();
    }

    /// `cluster_group` の serde-wasm-bindgen 境界 smoke（数値 parity とは別軸）。
    /// JS↔Rust の camelCase 整合・欠損 Option フィールド・Strictness の lowercase が
    /// wasm 実行時に破綻しないことを検証する（cluster ロジック自体は core 側でテスト済み）。
    #[wasm_bindgen_test]
    fn cluster_group_roundtrip() {
        use imgdiff_core::report::{DupGroup, ImageRecord};
        // pixel_sha256/phash=None（→ null）・thumb は skip（→ 欠損）で境界を通す。
        let rec = |path: &str, sha: &str| ImageRecord {
            path: path.into(),
            bytes: 10,
            width: 8,
            height: 8,
            format: "png".into(),
            sha256: sha.into(),
            pixel_sha256: None,
            phash: None,
            thumb: None,
        };
        let recs = vec![
            rec("a.png", "SHA_X"),
            rec("b.png", "SHA_X"),
            rec("c.png", "SHA_Y"),
        ];
        let input = serde_wasm_bindgen::to_value(&recs).unwrap();
        let out = cluster_group(input, "exact", None).unwrap();
        let groups: Vec<DupGroup> = serde_wasm_bindgen::from_value(out).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members, vec!["a.png".to_string(), "b.png".to_string()]);
        assert_eq!(groups[0].keeper, "a.png");
        assert!(groups[0].auto_deletable);
        // 未知の strictness はエラーになること。
        let bad = serde_wasm_bindgen::to_value(&recs).unwrap();
        assert!(cluster_group(bad, "bogus", None).is_err());
    }
}
