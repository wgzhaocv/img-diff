//! compare サブコマンド: 2 枚の画像を直接比較する（SPEC §3）。

use crate::output::{self, OutputFormat};
use crate::{decode, pipeline, util};
use anyhow::Result;
use clap::Args;
use imgdiff_core::report::{
    CompareResult, ImageRecord, Producer, Report, HASH_ALGO_VERSION, SCHEMA_VERSION,
};
use imgdiff_core::{compare as score, hash, preprocess};
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
        diff_image: None,
    };

    if out.is_json() {
        output::print_json(&Report::Compare(result))?;
    } else {
        print_text(&result);
    }
    Ok(())
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
}
