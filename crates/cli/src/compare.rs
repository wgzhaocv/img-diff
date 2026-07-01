//! compare サブコマンド: 2 枚の画像を直接比較する（SPEC §3）。

use crate::error::CliError;
use crate::output::{self, OutputFormat};
use crate::{decode, pipeline, util};
use anyhow::Result;
use clap::Args;
use imgdiff_core::report::{
    AssetRef, CompareResult, ImageRecord, Producer, Report, HASH_ALGO_VERSION, SCHEMA_VERSION,
};
use imgdiff_core::{compare as score, diff, hash, preprocess};
use std::path::{Path, PathBuf};

#[derive(Args)]
pub struct CompareArgs {
    /// 比較する画像 A
    a: PathBuf,
    /// 比較する画像 B
    b: PathBuf,
    /// ピクセル差の許容（各チャンネル差がこれ以下なら同一扱い。既定 0）
    #[arg(long, default_value_t = 0)]
    tolerance: u8,
    /// 差分ハイライト PNG の出力先（省略時は生成しない。寸法一致時のみ有効）
    #[arg(long, value_name = "PATH")]
    diff: Option<PathBuf>,
}

pub fn run(args: CompareArgs, out: OutputFormat) -> Result<()> {
    let (rgba_a, rec_a) = decode_record(&args.a)?;
    let (rgba_b, rec_b) = decode_record(&args.b)?;

    let sha_equal = rec_a.sha256 == rec_b.sha256;
    let dims_equal = rec_a.width == rec_b.width && rec_a.height == rec_b.height;
    let comparable = dims_equal;

    // 比較不能（寸法不一致）時は数値は None（SPEC §3）。
    let (pixel_equal, pixel_diff_ratio, ssim, psnr) = if comparable {
        let pe = rec_a.pixel_sha256 == rec_b.pixel_sha256;
        let pdr = score::pixel_diff_ratio(&rgba_a, &rgba_b, args.tolerance);
        let gray_a = preprocess::to_gray_rec601(&rgba_a);
        let gray_b = preprocess::to_gray_rec601(&rgba_b);
        let ss = score::ssim(&gray_a, &gray_b, rec_a.width, rec_a.height);
        let ps = score::psnr(&rgba_a, &rgba_b);
        (Some(pe), Some(pdr), Some(ss), Some(ps))
    } else {
        (None, None, None, None)
    };

    let hamming_distance = rec_a
        .phash
        .as_deref()
        .zip(rec_b.phash.as_deref())
        .and_then(|(a, b)| Some(hash::hamming(hash::from_hex(a)?, hash::from_hex(b)?)));

    // 差分ハイライト PNG（--diff 指定かつ比較可能時のみ生成）。
    let diff_image = match (&args.diff, comparable) {
        (Some(path), true) => Some(write_diff_png(
            &rgba_a,
            &rgba_b,
            rec_a.width,
            rec_a.height,
            args.tolerance,
            path,
        )?),
        (Some(path), false) => {
            // 比較不能（寸法不一致）は成功のまま。警告のみ（json は comparable:false が理由を示す）。
            if !out.is_json() {
                eprintln!(
                    "警告: 寸法が異なるため差分画像を生成しませんでした（{}）",
                    path.display()
                );
            }
            None
        }
        (None, _) => None,
    };

    let result = CompareResult {
        schema_version: SCHEMA_VERSION,
        producer: Producer {
            app: "cli".to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            vips: decode::vips_version_string(),
            hash_algo: HASH_ALGO_VERSION.to_string(),
        },
        created_at: util::now_rfc3339(),
        a: rec_a,
        b: rec_b,
        sha_equal,
        dims_equal,
        comparable,
        pixel_equal,
        pixel_diff_ratio,
        ssim,
        psnr,
        hamming_distance,
        diff_image,
    };

    if out.is_json() {
        output::print_json(&Report::Compare(result))?;
    } else {
        print_text(&result);
    }
    Ok(())
}

/// 差分ハイライトを生成し PNG として path に書き出し、AssetRef::Path を返す（SPEC §4）。
/// 拡張子に依らず PNG 固定。書き込み失敗は io_error で伝播する。
fn write_diff_png(
    rgba_a: &[u8],
    rgba_b: &[u8],
    width: u32,
    height: u32,
    tolerance: u8,
    path: &Path,
) -> Result<AssetRef> {
    let buf = diff::highlight(rgba_a, rgba_b, tolerance);
    image::save_buffer_with_format(
        path,
        &buf,
        width,
        height,
        image::ColorType::Rgba8,
        image::ImageFormat::Png,
    )
    .map_err(|e| CliError::new("io_error", format!("{}: {e}", path.display())))?;
    Ok(AssetRef::Path {
        path: path.display().to_string(),
    })
}

/// 1 枚をデコード→白平坦化し、ImageRecord と平坦化後 RGBA を返す（共通処理は pipeline）。
fn decode_record(path: &Path) -> Result<(Vec<u8>, ImageRecord)> {
    let d = pipeline::decode_and_hash(path)?;
    let rec = ImageRecord {
        path: path.display().to_string(),
        bytes: d.bytes,
        width: d.width,
        height: d.height,
        format: d.format,
        sha256: d.sha256,
        pixel_sha256: Some(d.rgba_sha256), // compare は 2 枚だけなので常に算出
        phash: Some(hash::to_hex(d.dhash)),
        thumb: None,
    };
    Ok((d.rgba, rec))
}

fn print_text(r: &CompareResult) {
    let dash = || "—".to_string();
    let fmt = |o: Option<f64>| o.map(|v| format!("{v:.4}")).unwrap_or_else(dash);
    println!("A: {}", r.a.path);
    println!("B: {}", r.b.path);
    println!("SHA 一致: {}", r.sha_equal);
    println!(
        "寸法一致: {} ({}x{} vs {}x{})",
        r.dims_equal, r.a.width, r.a.height, r.b.width, r.b.height
    );
    println!(
        "ハミング距離: {}",
        r.hamming_distance
            .map(|h| h.to_string())
            .unwrap_or_else(dash)
    );
    if r.comparable {
        println!(
            "ピクセル一致: {}",
            r.pixel_equal.map(|b| b.to_string()).unwrap_or_else(dash)
        );
        println!("差分割合: {}", fmt(r.pixel_diff_ratio));
        println!("SSIM: {}", fmt(r.ssim));
        println!("PSNR(dB): {}", fmt(r.psnr));
    } else {
        println!("比較不能（寸法が異なるためピクセル比較なし）");
    }
    if let Some(AssetRef::Path { path }) = &r.diff_image {
        println!("差分画像: {path}");
    }
}
