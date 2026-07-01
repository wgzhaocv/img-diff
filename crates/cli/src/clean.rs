//! clean サブコマンド: 重複画像を安全に削除する（SPEC §5.1）。
//! 削除時点でその場で再スキャンし、auto_deletable（exact/pixel）グループの keeper 以外だけを
//! **ゴミ箱**へ送る。既定は dry-run（何も削除しない）、`--apply` で実行。perceptual は選べない。

use crate::index::{self, IndexOptions};
use crate::output::{self, OutputFormat};
use crate::util;
use anyhow::Result;
use clap::{Args, ValueEnum};
use imgdiff_core::report::{
    CleanReport, CleanStats, Deletion, DeletionStatus, DupGroup, ImageRecord, PlannedDeletion,
    Report, Strictness, SCHEMA_VERSION,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Args)]
pub struct CleanArgs {
    /// 対象フォルダ（削除時点で再スキャンする）
    folder: PathBuf,
    /// 厳密度: exact(SHA一致) | pixel(ピクセル一致)。perceptual は自動削除しないため選べない
    #[arg(long, value_enum, default_value_t = CleanStrict::Pixel)]
    strict: CleanStrict,
    /// 実際に削除する（省略時は dry-run＝削除予定を出すだけ）
    #[arg(long)]
    apply: bool,
    /// サブディレクトリも再帰的に探索する
    #[arg(long, default_value_t = true)]
    recurse: bool,
    /// カンマ区切りの対象拡張子
    #[arg(long, default_value = "jpg,jpeg,png,webp,gif,bmp,tiff,heic,heif,avif")]
    ext: String,
}

/// clean の厳密度は exact/pixel のみ（perceptual は auto_deletable=false なので対象外）。
#[derive(Copy, Clone, ValueEnum)]
enum CleanStrict {
    Exact,
    Pixel,
}

impl CleanStrict {
    fn to_core(self) -> Strictness {
        match self {
            CleanStrict::Exact => Strictness::Exact,
            CleanStrict::Pixel => Strictness::Pixel,
        }
    }
}

pub fn run(args: CleanArgs, out: OutputFormat) -> Result<()> {
    let started = Instant::now();
    let strictness = args.strict.to_core();

    let opts = IndexOptions {
        folder: args.folder.clone(),
        strictness,
        threshold: None, // exact/pixel は閾値を使わない
        ext: index::parse_exts(&args.ext),
        recurse: args.recurse,
        // 削除は破壊的なので**必ず新規デコード**する（size/mtime キャッシュを信じない）。
        // 「削除時点で再スキャン」の安全前提をハッシュ計算まで徹底させる。
        no_cache: true,
        cache_dir: None,
    };
    let indexed = index::index_folder(&opts, out.is_json())?;

    let planned = plan_deletions(&indexed.images, &indexed.groups);
    let reclaimable_bytes: u64 = planned.iter().map(|p| p.bytes).sum();

    // apply 時のみ実削除（ゴミ箱送り）。dry-run は空。
    let (deletions, trashed_bytes) = if args.apply {
        apply_deletions(&args.folder, &planned)
    } else {
        (Vec::new(), 0)
    };

    // 各 Deletion は trashed / failed のどちらか一方なので、失敗数は差で求める。
    let trashed = deletions
        .iter()
        .filter(|d| d.status == DeletionStatus::Trashed)
        .count() as u32;
    let failed = deletions.len() as u32 - trashed;

    let report = CleanReport {
        schema_version: SCHEMA_VERSION,
        producer: util::cli_producer(),
        root: args.folder.display().to_string(),
        created_at: util::now_rfc3339(),
        strictness,
        dry_run: !args.apply,
        stats: CleanStats {
            scanned: indexed.images.len() as u32,
            groups: indexed.groups.iter().filter(|g| g.auto_deletable).count() as u32,
            planned: planned.len() as u32,
            trashed,
            failed,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        planned_deletions: planned,
        deletions,
        reclaimable_bytes,
        trashed_bytes,
    };

    if out.is_json() {
        output::print_json(&Report::Clean(report))?;
    } else {
        print_text(&report);
    }
    Ok(())
}

/// auto_deletable（exact/pixel）グループの keeper 以外を削除予定として組み立てる（純関数）。
/// path→bytes は images から引く。perceptual グループ（auto_deletable=false）は対象外。
/// 純ロジックなので、将来 web が削除プレビューを持つなら `cluster` と同様 core へ移す候補。
fn plan_deletions(images: &[ImageRecord], groups: &[DupGroup]) -> Vec<PlannedDeletion> {
    let bytes_of: HashMap<&str, u64> = images.iter().map(|r| (r.path.as_str(), r.bytes)).collect();
    let mut planned = Vec::new();
    for g in groups.iter().filter(|g| g.auto_deletable) {
        for m in g.members.iter().filter(|&m| *m != g.keeper) {
            planned.push(PlannedDeletion {
                path: m.clone(),
                group_id: g.id,
                bytes: bytes_of.get(m.as_str()).copied().unwrap_or(0),
                keeper: g.keeper.clone(),
            });
        }
    }
    planned
}

/// 削除予定を 1 件ずつゴミ箱へ送る。1 件失敗しても止めず per-file 記録。
/// 戻り値は (結果一覧, 実際に回収できたバイト合計)。
/// 注: check→delete 間の TOCTOU（別プロセスがジャンクションを差し替える等）は本ツールの
/// 想定範囲外（ローカルの自分のフォルダ整理用途）。canonical 検証を fail-closed にして最善を尽くす。
fn apply_deletions(root: &Path, planned: &[PlannedDeletion]) -> (Vec<Deletion>, u64) {
    // 安全ベルト用: ルートの正規化パス（取得できなければ全件を安全側で拒否する）。
    let root_canon = root.canonicalize().ok();
    let mut deletions = Vec::with_capacity(planned.len());
    let mut trashed_bytes = 0u64;
    for p in planned {
        let abs = resolve(root, &p.path);
        // 安全ベルト（fail-closed）: canonical パスがルート配下と**確認できたときだけ**削除する。
        // 正規化不能・ルート外・root 正規化失敗はいずれも削除せず failed に記録
        // （破壊的操作なので「確認できなければ消さない」）。
        let result = match (root_canon.as_ref(), abs.canonicalize()) {
            (Some(rc), Ok(ac)) if ac.starts_with(rc) => {
                trash::delete(&abs).map_err(|e| e.to_string())
            }
            _ => Err("削除対象がルート配下と確認できませんでした".to_string()),
        };
        match result {
            Ok(()) => {
                trashed_bytes += p.bytes;
                deletions.push(Deletion {
                    path: p.path.clone(),
                    status: DeletionStatus::Trashed,
                    error: None,
                });
            }
            Err(msg) => deletions.push(Deletion {
                path: p.path.clone(),
                status: DeletionStatus::Failed,
                error: Some(msg),
            }),
        }
    }
    (deletions, trashed_bytes)
}

/// root 相対パス（'/' 区切り）を native な絶対/相対パスへ戻す（index::rel_path の逆）。
fn resolve(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |acc, seg| acc.join(seg))
}

fn print_text(r: &CleanReport) {
    let mode = if r.dry_run {
        "dry-run（削除なし）"
    } else {
        "適用"
    };
    println!("clean: {} | 厳密度 {:?} | {}", r.root, r.strictness, mode);
    println!(
        "削除予定 {} 件 / 回収可能 {} bytes",
        r.planned_deletions.len(),
        r.reclaimable_bytes
    );
    for p in &r.planned_deletions {
        println!("  [dup ] {} (keeper: {})", p.path, p.keeper);
    }
    if r.dry_run {
        if !r.planned_deletions.is_empty() {
            println!("\n--apply で上記をゴミ箱へ送ります。");
        }
    } else {
        println!(
            "\nゴミ箱送り: 成功 {} / 失敗 {} / 回収 {} bytes",
            r.stats.trashed, r.stats.failed, r.trashed_bytes
        );
        for d in &r.deletions {
            match d.status {
                DeletionStatus::Trashed => println!("  [trashed] {}", d.path),
                DeletionStatus::Failed => {
                    println!(
                        "  [failed ] {} — {}",
                        d.path,
                        d.error.as_deref().unwrap_or("")
                    )
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(path: &str, bytes: u64) -> ImageRecord {
        ImageRecord {
            path: path.into(),
            bytes,
            width: 8,
            height: 8,
            format: "png".into(),
            sha256: "x".into(),
            pixel_sha256: None,
            phash: None,
            thumb: None,
        }
    }

    fn grp(id: u32, members: &[&str], keeper: &str, auto: bool) -> DupGroup {
        DupGroup {
            id,
            strictness: Strictness::Pixel,
            members: members.iter().map(|s| s.to_string()).collect(),
            keeper: keeper.into(),
            reclaimable_bytes: 0,
            auto_deletable: auto,
            max_hamming: None,
        }
    }

    #[test]
    fn plans_non_keeper_of_auto_deletable() {
        // keeper=a を残し、b/c を削除予定に。bytes は images から引く。
        let images = vec![img("a.png", 10), img("b.png", 20), img("c.png", 30)];
        let groups = vec![grp(0, &["a.png", "b.png", "c.png"], "a.png", true)];
        let planned = plan_deletions(&images, &groups);
        assert_eq!(planned.len(), 2);
        assert!(planned.iter().all(|p| p.path != "a.png"));
        assert!(planned.iter().all(|p| p.keeper == "a.png"));
        assert_eq!(planned.iter().map(|p| p.bytes).sum::<u64>(), 50);
    }

    #[test]
    fn skips_non_auto_deletable_groups() {
        // perceptual 相当（auto_deletable=false）は絶対に削除予定に入れない。
        let images = vec![img("a.png", 10), img("b.png", 20)];
        let groups = vec![grp(0, &["a.png", "b.png"], "a.png", false)];
        assert!(plan_deletions(&images, &groups).is_empty());
    }

    #[test]
    fn resolve_rejoins_relative_segments() {
        let root = Path::new("C:/imgs");
        assert_eq!(resolve(root, "sub/x.png"), Path::new("C:/imgs/sub/x.png"));
    }
}
