import type { DupGroup, ImageRecord, PlannedDeletion } from "@/lib/core";
import { removeByPath } from "@/lib/fsaccess";
import { deleteHash, deleteThumb } from "@/lib/db";

// 重複の実削除（SPEC §5.1 clean）。CLI `crates/cli/src/clean.rs` の安全モデルを web に踏襲する。
// **重大な差**: CLI はゴミ箱送り（復元可）だが、web にはゴミ箱がなく **removeEntry は恒久削除**。
// そのため呼び出し側で dry-run プレビュー + 明示確認（AlertDialog）を必須にする（DESIGN §6.3）。
// PlannedDeletion は web/CLI 共有契約 `schema`（report.rs と対）を正本として使う（手書きしない）。

/// 削除結果 1 件（CLI Deletion に対応）。web は恒久削除なので schema `Deletion`（trashed 前提）とは
/// 別に、ok/error だけの最小形にする。
export type DeletionOutcome = { path: string; ok: boolean; error?: string };

export type CleanResult = {
  outcomes: DeletionOutcome[];
  /** 実削除に成功したパス（store/キャッシュ reconcile 用）。 */
  deletedPaths: string[];
  deletedBytes: number;
};

/// autoDeletable（exact/pixel）グループの keeper 以外を削除予定に組む（純関数）。
/// CLI `clean.rs::plan_deletions` と同一規則: **perceptual は絶対に対象外**（autoDeletable=false・
/// 類似が非推移的で誤連の恐れ）、**keeper は必ず残す**。bytes は images から引く。
export function planDeletions(groups: DupGroup[], images: ImageRecord[]): PlannedDeletion[] {
  const bytesOf = new Map(images.map((r) => [r.path, r.bytes]));
  const planned: PlannedDeletion[] = [];
  for (const g of groups) {
    if (!g.autoDeletable) continue; // perceptual 等は要目視。触らない。
    for (const path of g.members) {
      if (path === g.keeper) continue; // 残す 1 枚は削除しない。
      planned.push({ path, groupId: g.id, bytes: bytesOf.get(path) ?? 0, keeper: g.keeper });
    }
  }
  return planned;
}

/// 削除予定を 1 件ずつ**恒久削除**する（FS Access 経路のみ・root ハンドル必須）。
/// 1 件失敗しても止めず per-file 記録（CLI 同様）。呼び出し側が readwrite 権限を取得済みである前提。
/// 実ファイル削除に成功したらキャッシュ（hashes/thumbs）も掃除する（掃除は best-effort＝
/// 失敗しても削除は成功扱い。次回スキャンの GC で整合）。
export async function applyDeletions(
  root: FileSystemDirectoryHandle,
  rootId: string,
  planned: PlannedDeletion[],
): Promise<CleanResult> {
  const outcomes: DeletionOutcome[] = [];
  const deletedPaths: string[] = [];
  let deletedBytes = 0;
  for (const p of planned) {
    try {
      await removeByPath(root, p.path);
    } catch (e) {
      outcomes.push({ path: p.path, ok: false, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    // ファイルは消えたのでキャッシュも掃除（正本 hashes → サムネ thumbs）。掃除失敗は非致命。
    await deleteHash(rootId, p.path).catch(() => {});
    await deleteThumb(rootId, p.path);
    deletedPaths.push(p.path);
    deletedBytes += p.bytes;
    outcomes.push({ path: p.path, ok: true });
  }
  return { outcomes, deletedPaths, deletedBytes };
}
