//! scan サブコマンド: フォルダをスキャンして重複/類似画像をグループ化する（SPEC §2,§5）。
//! 索引処理（スキャン+デコード+ハッシュ+clustering）は clean と共有するため `index` モジュールへ。

use crate::error::CliError;
use crate::index::{self, IndexOptions};
use crate::output::{self, OutputFormat};
use crate::util;
use anyhow::Result;
use clap::{Args, ValueEnum};
use imgdiff_core::report::{
    DupGroup, Producer, Report, ScanReport, ScanStats, SkippedFile, Strictness, SCHEMA_VERSION,
};
use serde::Serialize;
use std::path::PathBuf;
use std::time::Instant;

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
    #[arg(long, default_value = "jpg,jpeg,png,webp,gif,bmp,tiff,heic,heif,avif")]
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
    /// キャッシュを使わない（毎回デコードする）
    #[arg(long)]
    no_cache: bool,
    /// キャッシュ DB のディレクトリ（既定: OS キャッシュ/imgdiff）
    #[arg(long)]
    cache_dir: Option<PathBuf>,
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
    let exts = index::parse_exts(&args.ext);
    let threshold = matches!(strictness, Strictness::Perceptual).then_some(args.threshold);

    let opts = IndexOptions {
        folder: args.folder.clone(),
        strictness,
        threshold,
        ext: exts,
        recurse: args.recurse,
        no_cache: args.no_cache,
        cache_dir: args.cache_dir.clone(),
    };
    let index::Indexed {
        images,
        groups,
        skipped,
    } = index::index_folder(&opts, out.is_json())?;

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
        producer: util::cli_producer(),
        root: args.folder.display().to_string(),
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
        std::fs::write(path, json).map_err(|e| {
            CliError::new(
                "io_error",
                format!("JSON 書き出し失敗: {e}（出力先ディレクトリが存在するか確認してください）"),
            )
        })?;
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
