//! フォルダ索引の共有処理（scan / clean が共有）。
//! WalkDir 収集 → 並列デコード+ハッシュ（redb キャッシュ） → pixelSha256 剪定 → clustering。
//! libvips デコードは CLI 専有のため core でなくここに置く。

use crate::{cache, pipeline};
use anyhow::Result;
use imgdiff_core::report::{DupGroup, ImageRecord, SkippedFile, Strictness, HASH_ALGO_VERSION};
use imgdiff_core::{cluster, hash};
use indicatif::{ProgressBar, ProgressStyle};
use rayon::iter::Either;
use rayon::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// カンマ区切りの拡張子文字列を、小文字・ドット無しの一覧へ正規化する。
/// `index_folder` の拡張子マッチ（小文字比較）と対を成すため、パースはここに置く。
pub fn parse_exts(csv: &str) -> Vec<String> {
    csv.split(',').map(|s| s.trim().to_lowercase()).collect()
}

/// 索引の入力（scan / clean 共通）。
pub struct IndexOptions {
    /// 走査ルート。
    pub folder: PathBuf,
    pub strictness: Strictness,
    /// perceptual のときのみ意味を持つハミング閾値（他は None）。
    pub threshold: Option<u32>,
    /// 対象拡張子（小文字・ドット無し）。
    pub ext: Vec<String>,
    pub recurse: bool,
    pub no_cache: bool,
    pub cache_dir: Option<PathBuf>,
}

/// 索引の成果物。`images` / `skipped` は path 昇順（SPEC §4 の決定性）。
pub struct Indexed {
    pub images: Vec<ImageRecord>,
    pub groups: Vec<DupGroup>,
    pub skipped: Vec<SkippedFile>,
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

impl Hashed {
    /// cache::Entry（ヒット時 or ミスで作った新規）から Hashed を組む。ヒット/ミス両パス共通。
    fn from_entry(path: String, e: &cache::Entry) -> Hashed {
        Hashed {
            path,
            bytes: e.size,
            width: e.width,
            height: e.height,
            format: e.format.clone(),
            sha256: e.sha256.clone(),
            dhash: e.dhash,
            rgba_sha256: e.rgba_sha256.clone(),
        }
    }
}

/// フォルダを索引し、clustering まで行う。`quiet`（= json モード）で進捗バーを隠す。
pub fn index_folder(opts: &IndexOptions, quiet: bool) -> Result<Indexed> {
    let root = opts.folder.as_path();
    let max_depth = if opts.recurse { usize::MAX } else { 1 };

    let files: Vec<PathBuf> = WalkDir::new(root)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| opts.ext.contains(&x.to_lowercase()))
                .unwrap_or(false)
        })
        .collect();

    // 進捗は stderr。JSON モードでは出さない（捕捉されるので不要・ノイズ）。
    let pb = if quiet {
        ProgressBar::hidden()
    } else {
        let pb = ProgressBar::new(files.len() as u64);
        pb.set_style(
            ProgressStyle::with_template("{bar:40} {pos}/{len} デコード中")
                .unwrap_or_else(|_| ProgressStyle::default_bar()),
        );
        pb
    };

    // キャッシュを開く（失敗時は警告して無効化＝デコードにフォールバック）。
    let cache = if opts.no_cache {
        None
    } else {
        let dir = opts.cache_dir.clone().unwrap_or_else(default_cache_dir);
        match cache::Cache::open(&dir.join("cache.redb")) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("note: キャッシュを無効化します（{e:#}）");
                None
            }
        }
    };
    let cache_ref = cache.as_ref();

    // ファイル単位に並列でデコード+ハッシュ（キャッシュ命中はデコードを省く）。成功/失敗を 1 パスで振り分ける。
    let (results, mut skipped): (
        Vec<(Hashed, Option<(String, cache::Entry)>)>,
        Vec<SkippedFile>,
    ) = files
        .par_iter()
        .map(|path| {
            let r = hash_one(path, root, cache_ref, HASH_ALGO_VERSION);
            pb.inc(1);
            r
        })
        .partition_map(|r| match r {
            Ok(x) => Either::Left(x),
            Err(s) => Either::Right(s),
        });
    pb.finish_and_clear();

    // ミス分の新エントリを 1 トランザクションでキャッシュへ書く（失敗は警告のみ）。
    if let Some(c) = cache_ref {
        let fresh: Vec<(String, cache::Entry)> =
            results.iter().filter_map(|(_, e)| e.clone()).collect();
        if let Err(e) = c.write_all(&fresh) {
            eprintln!("note: キャッシュ書き込みに失敗（{e:#}）");
        }
    }
    let hashed: Vec<Hashed> = results.into_iter().map(|(h, _)| h).collect();

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

    let groups = cluster::group(&images, opts.strictness, opts.threshold);

    Ok(Indexed {
        images,
        groups,
        skipped,
    })
}

/// 1 枚を（キャッシュ命中なら省略して）デコード+ハッシュする。失敗時は理由付きの SkippedFile。
/// 戻り値の 2 番目はキャッシュへ書く新エントリ（ヒット時は None）。
fn hash_one(
    path: &Path,
    root: &Path,
    cache: Option<&cache::Cache>,
    hash_algo: &str,
) -> std::result::Result<(Hashed, Option<(String, cache::Entry)>), SkippedFile> {
    let rel = rel_path(path, root);
    let inner = || -> Result<(Hashed, Option<(String, cache::Entry)>)> {
        let meta = std::fs::metadata(path)?;
        let size = meta.len();
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as u64);
        // 絶対パスをキャッシュキーにする（cwd や指定方法に依らず安定）。
        let key = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned();

        // キャッシュ照合（mtime が取れたときのみ）。命中ならデコードを省く。
        if let (Some(c), Some(mt)) = (cache, mtime_ns) {
            if let Some(e) = c.get(&key, size, mt, hash_algo) {
                return Ok((Hashed::from_entry(rel.clone(), e), None));
            }
        }

        // ミス → デコード+ハッシュ（d.rgba は索引では不要なので破棄）。
        let d = pipeline::decode_and_hash(path)?;
        let entry = cache::Entry {
            size,
            mtime_ns: mtime_ns.unwrap_or(0),
            hash_algo: hash_algo.to_string(),
            sha256: d.sha256,
            rgba_sha256: d.rgba_sha256,
            dhash: d.dhash,
            width: d.width,
            height: d.height,
            format: d.format,
        };
        let hashed = Hashed::from_entry(rel.clone(), &entry);
        // mtime が取れたときだけキャッシュへ書く（取れない時はキャッシュしない）。
        let new = mtime_ns.map(|_| (key, entry));
        Ok((hashed, new))
    };
    inner().map_err(|e| SkippedFile {
        path: rel,
        reason: format!("{e:#}"),
    })
}

/// 既定のキャッシュディレクトリ（OS キャッシュ/imgdiff、取得不可なら ./.imgdiff）。
fn default_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .map(|d| d.join("imgdiff"))
        .unwrap_or_else(|| PathBuf::from(".imgdiff"))
}

/// 走査ルートからの相対パスを '/' 区切りで返す（SPEC §4）。
fn rel_path(path: &Path, root: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}
