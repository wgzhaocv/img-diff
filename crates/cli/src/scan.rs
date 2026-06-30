//! scan サブコマンド: フォルダを走査して重複/類似画像をグループ化する（SPEC §2,§5）。

use crate::error::CliError;
use crate::output::{self, OutputFormat};
use crate::{decode, pipeline, util};
use anyhow::Result;
use clap::{Args, ValueEnum};
use imgdiff_core::report::{
    DupGroup, ImageRecord, Producer, Report, ScanReport, ScanStats, SkippedFile, Strictness,
    HASH_ALGO_VERSION, SCHEMA_VERSION,
};
use imgdiff_core::{cluster, hash};
use indicatif::{ProgressBar, ProgressStyle};
use rayon::iter::Either;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;
use walkdir::WalkDir;

#[derive(Args)]
pub struct ScanArgs {
    /// スキャン対象のフォルダ
    folder: PathBuf,
    /// 厳密度: exact(SHA一致) | pixel(ピクセル一致) | perceptual(知覚的に類似)
    #[arg(long, value_enum, default_value_t = Strict::Perceptual)]
    strict: Strict,
    /// ハミング距離のしきい値（perceptual のみ有効）
    #[arg(long, default_value_t = 10)]
    threshold: u32,
    /// サブディレクトリも再帰的に探索する
    #[arg(long, default_value_t = true)]
    recurse: bool,
    /// カンマ区切りの対象拡張子
    #[arg(long, default_value = "jpg,jpeg,png,webp,gif,bmp,tiff")]
    ext: String,
    /// 完全な ScanReport(images[] 込み)を JSON ファイルへ書き出す
    #[arg(long)]
    json: Option<PathBuf>,
    /// stdout の JSON にも images[] を含める（既定は要約のみ＝AI のトークン節約）
    #[arg(long)]
    full: bool,
    /// HTML レポート（未対応）
    #[arg(long)]
    html: Option<PathBuf>,
}

#[derive(Copy, Clone, ValueEnum)]
enum Strict {
    Exact,
    Pixel,
    Perceptual,
}

impl Strict {
    fn to_core(self) -> Strictness {
        match self {
            Strict::Exact => Strictness::Exact,
            Strict::Pixel => Strictness::Pixel,
            Strict::Perceptual => Strictness::Perceptual,
        }
    }
}

/// デコード+ハッシュの中間結果（pixelSha256 剪定の前）。
struct Hashed {
    path: String,
    bytes: u64,
    width: u32,
    height: u32,
    format: String,
    sha256: String,
    dhash: u64,
    rgba_sha256: String,
}

/// stdout 既定の要約（images[] を含まない）。AI のトークン節約用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanSummary<'a> {
    schema_version: u32,
    kind: &'static str,
    producer: &'a Producer,
    root: &'a str,
    created_at: &'a str,
    strictness: Strictness,
    threshold: Option<u32>,
    groups: &'a [DupGroup],
    skipped_files: &'a [SkippedFile],
    stats: &'a ScanStats,
}

pub fn run(args: ScanArgs, out: OutputFormat) -> Result<()> {
    if args.html.is_some() {
        return Err(CliError::new(
            "unsupported",
            "HTML レポートは未対応です（web レンダラ未実装。--json でデータを取得してください）",
        )
        .into());
    }
    let started = Instant::now();
    let strictness = args.strict.to_core();
    let exts: Vec<String> = args
        .ext
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .collect();
    let max_depth = if args.recurse { usize::MAX } else { 1 };
    let root = &args.folder;

    let files: Vec<PathBuf> = WalkDir::new(root)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| exts.contains(&x.to_lowercase()))
                .unwrap_or(false)
        })
        .collect();

    // 進捗は stderr。JSON モードでは出さない（捕捉されるので不要・ノイズ）。
    let pb = if out.is_json() {
        ProgressBar::hidden()
    } else {
        let pb = ProgressBar::new(files.len() as u64);
        pb.set_style(
            ProgressStyle::with_template("{bar:40} {pos}/{len} デコード中")
                .unwrap_or_else(|_| ProgressStyle::default_bar()),
        );
        pb
    };

    // ファイル単位に並列でデコード+ハッシュ。成功/失敗を 1 パスで振り分ける。
    let (hashed, mut skipped): (Vec<Hashed>, Vec<SkippedFile>) = files
        .par_iter()
        .map(|path| {
            let r = hash_one(path, root);
            pb.inc(1);
            r
        })
        .partition_map(|r| match r {
            Ok(h) => Either::Left(h),
            Err(s) => Either::Right(s),
        });
    pb.finish_and_clear();
    // 出力の決定性（SPEC §4）: skippedFiles は path 昇順。
    skipped.sort_by(|a, b| a.path.cmp(&b.path));

    // pixelSha256 剪定（SPEC §2.1）: dHash 値でバケットし、メンバ ≥2 のみ pixel_sha256 を設定。
    let mut counts: HashMap<u64, u32> = HashMap::new();
    for h in &hashed {
        *counts.entry(h.dhash).or_insert(0) += 1;
    }
    let mut images: Vec<ImageRecord> = hashed
        .iter()
        .map(|h| ImageRecord {
            path: h.path.clone(),
            bytes: h.bytes,
            width: h.width,
            height: h.height,
            format: h.format.clone(),
            sha256: h.sha256.clone(),
            pixel_sha256: (counts[&h.dhash] >= 2).then(|| h.rgba_sha256.clone()),
            phash: Some(hash::to_hex(h.dhash)),
            thumb: None,
        })
        .collect();
    // 出力の決定性（SPEC §4）: images は path 昇順（groups の順序には影響しない）。
    images.sort_by(|a, b| a.path.cmp(&b.path));

    let threshold = matches!(strictness, Strictness::Perceptual).then_some(args.threshold);
    let groups = cluster::group(&images, strictness, threshold);

    let duplicates: u32 = groups.iter().map(|g| g.members.len() as u32 - 1).sum();
    let reclaimable: u64 = groups.iter().map(|g| g.reclaimable_bytes).sum();
    let stats = ScanStats {
        scanned: images.len() as u32,
        skipped: skipped.len() as u32,
        groups: groups.len() as u32,
        duplicates,
        reclaimable_bytes: reclaimable,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };

    let report = ScanReport {
        schema_version: SCHEMA_VERSION,
        producer: Producer {
            app: "cli".to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            vips: decode::vips_version_string(),
            hash_algo: HASH_ALGO_VERSION.to_string(),
        },
        root: root.display().to_string(),
        created_at: util::now_rfc3339(),
        strictness,
        threshold,
        images,
        groups,
        skipped_files: skipped,
        stats,
    };

    // --json: 完全な Report をファイルへ。
    if let Some(path) = &args.json {
        let json = serde_json::to_string_pretty(&Report::Scan(report.clone()))?;
        std::fs::write(path, json)
            .map_err(|e| CliError::new("io_error", format!("JSON 書き出し失敗: {e}")))?;
        eprintln!("完全レポートを書き出しました: {}", path.display());
    }

    // stdout 出力。
    if out.is_json() {
        if args.full {
            output::print_json(&Report::Scan(report))?;
        } else {
            output::print_json(&ScanSummary {
                schema_version: report.schema_version,
                kind: "scan",
                producer: &report.producer,
                root: &report.root,
                created_at: &report.created_at,
                strictness: report.strictness,
                threshold: report.threshold,
                groups: &report.groups,
                skipped_files: &report.skipped_files,
                stats: &report.stats,
            })?;
        }
    } else {
        print_text(&report);
    }
    Ok(())
}

/// 1 枚をデコード+ハッシュする。失敗時は理由付きの SkippedFile。
/// 共通処理は `pipeline::decode_and_hash`。ここは相対パスとエラー振り分けだけを担う
/// （d.rgba は scan では不要なので破棄される）。
fn hash_one(path: &Path, root: &Path) -> std::result::Result<Hashed, SkippedFile> {
    let rel = rel_path(path, root);
    match pipeline::decode_and_hash(path) {
        Ok(d) => Ok(Hashed {
            path: rel,
            bytes: d.bytes,
            width: d.width,
            height: d.height,
            format: d.format,
            sha256: d.sha256,
            dhash: d.dhash,
            rgba_sha256: d.rgba_sha256,
        }),
        Err(e) => Err(SkippedFile {
            path: rel,
            reason: format!("{e:#}"),
        }),
    }
}

/// 走査ルートからの相対パスを '/' 区切りで返す（SPEC §4）。
fn rel_path(path: &Path, root: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn print_text(r: &ScanReport) {
    println!(
        "スキャン: {} | 厳密度 {:?} | {} 枚 | {} グループ | 重複 {} | 回収可能 {} bytes",
        r.root,
        r.strictness,
        r.stats.scanned,
        r.stats.groups,
        r.stats.duplicates,
        r.stats.reclaimable_bytes
    );
    if r.stats.skipped > 0 {
        println!("スキップ: {} 件", r.stats.skipped);
    }
    for g in &r.groups {
        let kind = if g.auto_deletable {
            "自動削除可"
        } else {
            "要目視"
        };
        let dist = g
            .max_hamming
            .map(|h| format!(", 最大距離 {h}"))
            .unwrap_or_default();
        println!(
            "\n[group {}] {} ({} 枚, 回収 {} bytes{})",
            g.id,
            kind,
            g.members.len(),
            g.reclaimable_bytes,
            dist
        );
        for m in &g.members {
            let mark = if *m == g.keeper { "keep" } else { "dup " };
            println!("  [{mark}] {m}");
        }
    }
}
