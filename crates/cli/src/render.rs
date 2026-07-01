//! render サブコマンド: SVG(ベクタ)を PNG に栅格化する（SPEC §5.3）。
//! libvips が SVG を描画（`--scale` で高精細化）→ 透明保持の RGBA を PNG として書き出す。
//! imgdiff の本分（重複検出）とは別の補助ツール。破壊的操作は無し（元ファイルは触らない）。

use crate::error::CliError;
use crate::output::{self, OutputFormat};
use crate::{decode, util};
use anyhow::Result;
use clap::Args;
use imgdiff_core::report::{
    RenderItem, RenderReport, RenderStats, RenderStatus, Report, SCHEMA_VERSION,
};
use std::path::{Path, PathBuf};
use std::time::Instant;
use walkdir::WalkDir;

#[derive(Args)]
pub struct RenderArgs {
    /// 入力（SVG ファイル、またはそれを含むディレクトリ）
    path: PathBuf,
    /// 出力先ディレクトリ（省略時は各ファイルと同じ場所に .png を書く。指定時は相対構造を保つ）
    #[arg(long)]
    out_dir: Option<PathBuf>,
    /// 描画スケール（ベクタを何倍の解像度で描くか。既定 1.0＝SVG 宣言サイズ）
    #[arg(long, default_value_t = 1.0)]
    scale: f64,
    /// サブディレクトリも再帰的に探索する
    #[arg(long, default_value_t = true)]
    recurse: bool,
    /// 対象拡張子（カンマ区切り。既定 svg）
    #[arg(long, default_value = "svg")]
    ext: String,
    /// 出力先が既に存在しても上書きする（既定は飛ばす）
    #[arg(long)]
    overwrite: bool,
}

pub fn run(args: RenderArgs, out: OutputFormat) -> Result<()> {
    let started = Instant::now();
    let exts: Vec<String> = args
        .ext
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .collect();

    // 入力を収集（単一ファイル or ディレクトリ walk）。root は out_dir 指定時の相対構造の基準。
    let (root, files) = collect(&args.path, &exts, args.recurse)?;

    let mut items: Vec<RenderItem> = files
        .iter()
        .map(|src| {
            let dst = dest_path(src, &root, args.out_dir.as_deref());
            render_one(src, &dst, args.scale, args.overwrite)
        })
        .collect();
    // 決定性（SPEC §4）: src の昇順。
    items.sort_by(|a, b| a.src.cmp(&b.src));

    let rendered = items
        .iter()
        .filter(|i| i.status == RenderStatus::Rendered)
        .count() as u32;
    let skipped = items
        .iter()
        .filter(|i| i.status == RenderStatus::Skipped)
        .count() as u32;
    let failed = items
        .iter()
        .filter(|i| i.status == RenderStatus::Failed)
        .count() as u32;

    let report = RenderReport {
        schema_version: SCHEMA_VERSION,
        producer: util::cli_producer(),
        root: args.path.display().to_string(),
        created_at: util::now_rfc3339(),
        scale: args.scale,
        stats: RenderStats {
            scanned: files.len() as u32,
            rendered,
            skipped,
            failed,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        items,
    };

    if out.is_json() {
        output::print_json(&Report::Render(report))?;
    } else {
        print_text(&report);
    }
    Ok(())
}

/// 入力を収集。ファイルならそれ 1 件（root=親）、ディレクトリなら対象拡張子を walk。
fn collect(path: &Path, exts: &[String], recurse: bool) -> Result<(PathBuf, Vec<PathBuf>)> {
    if path.is_file() {
        let root = path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        return Ok((root, vec![path.to_path_buf()]));
    }
    if !path.is_dir() {
        return Err(CliError::new(
            "not_found",
            format!(
                "{}: ファイルもディレクトリも見つかりません（パスを確認してください）",
                path.display()
            ),
        )
        .into());
    }
    let max_depth = if recurse { usize::MAX } else { 1 };
    let files: Vec<PathBuf> = WalkDir::new(path)
        .max_depth(max_depth)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| exts.contains(&x.to_lowercase()))
                .unwrap_or(false)
        })
        .collect();
    Ok((path.to_path_buf(), files))
}

/// 出力 PNG のパスを決める。out_dir 無し=元と同じ場所（拡張子を png へ）。
/// out_dir 有り=root からの相対を out_dir 配下へ（相対構造を保つ）。
fn dest_path(src: &Path, root: &Path, out_dir: Option<&Path>) -> PathBuf {
    match out_dir {
        None => src.with_extension("png"),
        Some(od) => {
            let rel = src.strip_prefix(root).unwrap_or(src);
            od.join(rel).with_extension("png")
        }
    }
}

/// 1 件を栅格化する。出力先が既存かつ --overwrite 無しなら skip。失敗は per-file 記録（全体は止めない）。
fn render_one(src: &Path, dst: &Path, scale: f64, overwrite: bool) -> RenderItem {
    let mk = |width, height, bytes, status, error| RenderItem {
        src: src.display().to_string(),
        dst: dst.display().to_string(),
        width,
        height,
        bytes,
        status,
        error,
    };
    if dst.exists() && !overwrite {
        return mk(0, 0, 0, RenderStatus::Skipped, None);
    }
    match render_inner(src, dst, scale) {
        Ok((w, h, bytes)) => mk(w, h, bytes, RenderStatus::Rendered, None),
        Err(e) => mk(0, 0, 0, RenderStatus::Failed, Some(format!("{e:#}"))),
    }
}

/// デコード(scale 適用)→ 透明保持のまま PNG として書き出す。
fn render_inner(src: &Path, dst: &Path, scale: f64) -> Result<(u32, u32, u64)> {
    let d = decode::decode_scaled(src, scale)?;
    if let Some(parent) = dst.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CliError::new("io_error", format!("出力先ディレクトリの作成に失敗: {e}"))
            })?;
        }
    }
    image::save_buffer_with_format(
        dst,
        &d.rgba,
        d.width,
        d.height,
        image::ColorType::Rgba8,
        image::ImageFormat::Png,
    )
    .map_err(|e| {
        CliError::new(
            "io_error",
            format!(
                "{}: PNG 書き出しに失敗: {e}（出力先が書き込み可能か確認してください）",
                dst.display()
            ),
        )
    })?;
    let bytes = std::fs::metadata(dst).map(|m| m.len()).unwrap_or(0);
    Ok((d.width, d.height, bytes))
}

fn print_text(r: &RenderReport) {
    println!(
        "render: {} (scale {}) | 走査 {} | 生成 {} | skip {} | 失敗 {}",
        r.root, r.scale, r.stats.scanned, r.stats.rendered, r.stats.skipped, r.stats.failed
    );
    for it in &r.items {
        let mark = match it.status {
            RenderStatus::Rendered => format!("OK {}x{}", it.width, it.height),
            RenderStatus::Skipped => "skip  ".to_string(),
            RenderStatus::Failed => format!("失敗: {}", it.error.as_deref().unwrap_or("")),
        };
        println!("  [{mark}] {} -> {}", it.src, it.dst);
    }
}
