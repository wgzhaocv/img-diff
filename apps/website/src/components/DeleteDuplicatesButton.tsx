import { useMemo, useState } from "react";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { planDeletions } from "@/lib/clean";
import { formatBytes } from "@/lib/format";
import { useScanStore } from "@/lib/stores/scanStore";

// プレビューに並べる最大件数（数千件でも DOM を膨らませない。残りは件数表記に集約）。
const PREVIEW_LIMIT = 100;

// 重複の実削除ボタン + 強確認 AlertDialog（SPEC §5.1・破壊的）。
// autoDeletable（完全一致/ピクセル一致）グループの keeper 以外だけが対象。
// FS Access 経路（rootHandle あり）でのみ有効。File[] 経路は永続ハンドルが無く削除できないので
// ボタンを無効化して理由を添える（DESIGN §6）。
export function DeleteDuplicatesButton() {
  const groups = useScanStore((s) => s.groups);
  const images = useScanStore((s) => s.result?.images);
  const rootId = useScanStore((s) => s.result?.rootId);
  const rootHandle = useScanStore((s) => s.rootHandle);
  const deleteDuplicates = useScanStore((s) => s.deleteDuplicates);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const planned = useMemo(() => planDeletions(groups, images ?? []), [groups, images]);
  const reclaim = useMemo(() => planned.reduce((sum, p) => sum + p.bytes, 0), [planned]);

  if (planned.length === 0) return null; // 自動削除できる重複が無い（perceptual のみ・重複なし等）。

  // File[] 経路（ドラッグ&ドロップ / input）は永続ハンドルが無く削除不可。無効化して理由を示す。
  const canDelete = !!rootHandle && !!rootId;
  if (!canDelete) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="destructive" size="sm" disabled className="gap-1.5">
          <Trash2 className="size-4" />
          <span className="num">{planned.length}</span> 件を削除
        </Button>
        <span className="text-xs text-muted-foreground">
          削除は「フォルダを選ぶ」で開いたときのみ（ドラッグ&ドロップは不可）
        </span>
      </div>
    );
  }

  async function onConfirm(): Promise<void> {
    setBusy(true);
    try {
      await deleteDuplicates();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  const shown = planned.slice(0, PREVIEW_LIMIT);
  const rest = planned.length - shown.length;

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" className="gap-1.5">
          <Trash2 className="size-4" />
          <span className="num">{planned.length}</span> 件を削除（
          <span className="num">{formatBytes(reclaim)}</span> 回収）
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            重複 <span className="num">{planned.length}</span> 件を削除しますか？
          </AlertDialogTitle>
          <AlertDialogDescription>
            完全一致・ピクセル一致グループの「残す 1
            枚」以外を削除します。各グループの代表と、見た目が近いだけのグループは削除しません。
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* 恒久削除の明示警告（web にゴミ箱は無い）。色だけに頼らずアイコン+テキストで示す。 */}
        <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="space-y-0.5">
            <p className="font-medium text-destructive">元に戻せません</p>
            <p className="text-foreground">
              このブラウザにはゴミ箱がありません。削除したファイルは恒久的に消え、復元できません。
            </p>
          </div>
        </div>

        <div className="text-sm text-muted-foreground">
          対象 <span className="num text-foreground">{planned.length}</span> 件 / 回収{" "}
          <span className="num text-foreground">{formatBytes(reclaim)}</span>
        </div>

        {/* dry-run プレビュー: 削除されるファイル（残す 1 枚は除外済み）。 */}
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/40 p-2 text-xs">
          {shown.map((p) => (
            <li key={p.path} className="truncate text-muted-foreground" title={p.path}>
              {p.path}
            </li>
          ))}
          {rest > 0 ? (
            <li className="text-muted-foreground">
              …他 <span className="num">{rest}</span> 件
            </li>
          ) : null}
        </ul>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>やめる</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={busy}
            onClick={(e) => {
              e.preventDefault(); // 非同期削除の完了まで自動クローズさせない。
              void onConfirm();
            }}
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                削除中…
              </>
            ) : (
              <>
                <Trash2 className="size-4" />
                永久に削除する
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
