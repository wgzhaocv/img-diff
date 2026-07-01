//! find サブコマンド: 1 枚の画像を問い合わせ、フォルダ内の類似画像を層別（exact/pixel/perceptual）に列挙する（SPEC §5.2）。
//! scan の索引（並列デコード+ハッシュ+redb キャッシュ）を `index::hash_folder` で流用し、問い合わせ画像と 1 対 N で突き合わせる。

use crate::index::{self, IndexOptions};
use crate::output::{self, OutputFormat};
use crate::{pipeline, util};
use anyhow::Result;
use clap::Args;
use imgdiff_core::hash;
use imgdiff_core::report::{
    FindMatch, FindReport, FindStats, FindTier, ImageRecord, Report, Strictness, SCHEMA_VERSION,
};
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Args)]
pub struct FindArgs {
    /// 問い合わせ画像（このファイルに似たものを folder 内で探す）
    query: PathBuf,
    /// 探索対象のフォルダ
    folder: PathBuf,
    /// perceptual 層のハミング閾値（これ以下を類似とみなす）
    #[arg(long, default_value_t = 10)]
    threshold: u32,
    /// サブディレクトリも再帰的に探索する
    #[arg(long, default_value_t = true)]
    recurse: bool,
    /// カンマ区切りの対象拡張子
    #[arg(long, default_value = "jpg,jpeg,png,webp,gif,bmp,tiff,heic,heif,avif")]
    ext: String,
    /// 上位 N 件だけ返す（層順→距離昇順で上位。省略時は全件）
    #[arg(long)]
    top: Option<usize>,
    /// キャッシュを使わない（毎回デコードする）
    #[arg(long)]
    no_cache: bool,
    /// キャッシュ DB のディレクトリ（既定: OS キャッシュ/imgdiff）
    #[arg(long)]
    cache_dir: Option<PathBuf>,
}

pub fn run(args: FindArgs, out: OutputFormat) -> Result<()> {
    let started = Instant::now();

    // 問い合わせ画像をデコード+ハッシュ（読み込み失敗=not_found・デコード失敗=decode_error はここで伝播）。
    let q = pipeline::decode_and_hash(&args.query)?;
    let query_rec = ImageRecord {
        path: args.query.display().to_string(),
        bytes: q.bytes,
        width: q.width,
        height: q.height,
        format: q.format.clone(),
        sha256: q.sha256.clone(),
        pixel_sha256: Some(q.rgba_sha256.clone()), // 問い合わせは 1 枚なので常に算出（compare と同じ）
        phash: Some(hash::to_hex(q.dhash)),
        thumb: None,
    };

    // フォルダを索引（scan と同じ並列+キャッシュ経路）。clustering はしないので strictness は未使用。
    let opts = IndexOptions {
        folder: args.folder.clone(),
        strictness: Strictness::Perceptual,
        threshold: Some(args.threshold),
        ext: index::parse_exts(&args.ext),
        recurse: args.recurse,
        no_cache: args.no_cache,
        cache_dir: args.cache_dir.clone(),
    };
    let (hashed, skipped) = index::hash_folder(&opts, out.is_json())?;
    let scanned = hashed.len() as u32;

    // 問い合わせ画像が folder 内にある場合、それ自身は結果から除外する（絶対パスで判定）。
    let query_abs = std::fs::canonicalize(&args.query).ok();
    let root = args.folder.as_path();

    // 1 対 N の突き合わせ。層を決め、perceptual は閾値内のみ採用。
    let mut matches: Vec<FindMatch> = Vec::new();
    for h in &hashed {
        let dist = hash::hamming(q.dhash, h.dhash);
        let tier = if h.sha256 == q.sha256 {
            // 自身（folder 内の問い合わせ画像そのもの）なら除外。自身は必ず SHA 一致なのでここだけ確認すれば十分。
            if is_self(query_abs.as_deref(), root, &h.path) {
                continue;
            }
            FindTier::Exact
        } else if h.rgba_sha256 == q.rgba_sha256 {
            FindTier::Pixel
        } else if dist <= args.threshold {
            FindTier::Perceptual
        } else {
            continue;
        };
        matches.push(FindMatch {
            path: h.path.clone(),
            bytes: h.bytes,
            width: h.width,
            height: h.height,
            format: h.format.clone(),
            tier,
            hamming_distance: dist,
        });
    }

    // 並び: 層（exact→pixel→perceptual）→ 距離昇順 → path 昇順（SPEC §4 の決定性）。
    matches.sort_by(|a, b| {
        tier_rank(a.tier)
            .cmp(&tier_rank(b.tier))
            .then(a.hamming_distance.cmp(&b.hamming_distance))
            .then_with(|| a.path.cmp(&b.path))
    });
    if let Some(n) = args.top {
        matches.truncate(n);
    }

    let stats = FindStats {
        scanned,
        skipped: skipped.len() as u32,
        matched: matches.len() as u32,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    let report = FindReport {
        schema_version: SCHEMA_VERSION,
        producer: util::cli_producer(),
        root: args.folder.display().to_string(),
        created_at: util::now_rfc3339(),
        threshold: args.threshold,
        query: query_rec,
        matches,
        skipped_files: skipped,
        stats,
    };

    if out.is_json() {
        output::print_json(&Report::Find(report))?;
    } else {
        print_text(&report);
    }
    Ok(())
}

/// 層の並び順（小さいほど上位）。
fn tier_rank(t: FindTier) -> u8 {
    match t {
        FindTier::Exact => 0,
        FindTier::Pixel => 1,
        FindTier::Perceptual => 2,
    }
}

/// `root/rel` が問い合わせ画像そのものか（絶対パス正規化で判定）。canonicalize 失敗時は false。
fn is_self(query_abs: Option<&Path>, root: &Path, rel: &str) -> bool {
    match query_abs {
        Some(qa) => std::fs::canonicalize(root.join(rel))
            .map(|ha| ha == qa)
            .unwrap_or(false),
        None => false,
    }
}

fn print_text(r: &FindReport) {
    println!(
        "検索: {} を {} 内で（閾値 {}）| 走査 {} 枚 | 一致 {} 件",
        r.query.path, r.root, r.threshold, r.stats.scanned, r.stats.matched
    );
    if r.stats.skipped > 0 {
        println!("スキップ: {} 件", r.stats.skipped);
    }
    if r.matches.is_empty() {
        println!("類似なし");
        return;
    }
    for m in &r.matches {
        let tier = match m.tier {
            FindTier::Exact => "完全一致",
            FindTier::Pixel => "画素一致",
            FindTier::Perceptual => "近似    ",
        };
        println!("  [{tier} d={:>2}] {}", m.hamming_distance, m.path);
    }
}
