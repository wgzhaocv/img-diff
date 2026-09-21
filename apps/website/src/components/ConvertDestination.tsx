import { useMemo } from "react";
import { AlertCircle, FileArchive, FolderDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resolveSink } from "@/lib/convertSinks";
import { previewSettled, resolveOptions, useConvertStore } from "@/lib/stores/convertStore";

// **保存先が実行ボタンそのもの。** 行き先を先に選ばせてから「変換する」を押させる必要は無い ——
// 今の設定での結果はプレビューが既に見せているので、残る判断は「どこへ置くか」だけ。
// 入力フォルダには決して書かない（SPEC §5.4）ので、置き場所は別に選ぶフォルダか zip の 2 つ。
//
// 押せるのは**今の設定での 1 枚を試し終えてから**（`previewSettled`）。
// 見ていない結果をまとめて書き出させない。

/** zip 出力のファイル名。 */
const ZIP_NAME = "imgdiff-converted.zip";

export function ConvertDestination() {
  const sources = useConvertStore((s) => s.sources);
  const form = useConvertStore((s) => s.form);
  const sourceInfo = useConvertStore((s) => s.sourceInfo);
  const inputRoot = useConvertStore((s) => s.inputRoot);
  const converting = useConvertStore((s) => s.status === "converting");
  const settled = useConvertStore(previewSettled);
  const setForm = useConvertStore((s) => s.setForm);
  const run = useConvertStore((s) => s.run);
  const cancel = useConvertStore((s) => s.cancel);
  const validate = useConvertStore((s) => s.validate);
  const validateCollisions = useConvertStore((s) => s.validateCollisions);

  // 実行できない理由は**押す前に**出す（UI.md §6.1「送信するまで黙っている形にしない」）。
  // 出力名の衝突検査だけは全件を舐めるので、**それが変わり得る入力にだけ**結び付ける
  // （文字を 1 つ打つたび・スライダを動かすたびに数千件を再走査しない）。
  const collision = useMemo(() => validateCollisions(), [sources, form.format, validateCollisions]);
  // `sourceInfo` も入力である: 原寸はサムネと一緒に後から届き、`validate` の
  // 「大きすぎる」判定はそれに依る（「もっと見る」で増えた分も含む）。
  const problem = useMemo(
    () => validate() ?? collision,
    [form, sources, sourceInfo, validate, collision],
  );

  /**
   * 書き出す。**picker は resolveSink が開く。ここから同期で呼ぶ** —— 先に await すると
   * transient activation が切れてブラウザに拒否される。
   */
  async function start(destination: "folder" | "zip"): Promise<void> {
    if (problem) {
      toast.error(problem);
      return;
    }
    // **押した瞬間の設定で固める。** 出力先を選んでいる間にフォームが動くことがある
    // （サムネの到着で寸法が入る等）ので、後から読み直すと別の変換になってしまう。
    const resolved = resolveOptions(form);
    if ("error" in resolved) {
      toast.error(resolved.error);
      return;
    }
    const choice = await resolveSink(
      { destination, overwrite: form.overwrite },
      inputRoot,
      ZIP_NAME,
    );
    if (choice.kind === "cancelled") return;
    if (choice.kind === "error") {
      toast.error(choice.title, { description: choice.description });
      return;
    }
    await run(choice.sink, resolved.options);
  }

  const blocked = converting || problem !== null || !settled;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void start("folder")} disabled={blocked} className="gap-1.5">
          <FolderDown className="size-4" />
          フォルダへ保存
        </Button>
        <Button
          variant="outline"
          onClick={() => void start("zip")}
          disabled={blocked}
          className="gap-1.5"
        >
          <FileArchive className="size-4" />
          zip でダウンロード
        </Button>
        {converting ? (
          <Button variant="ghost" onClick={cancel}>
            中断
          </Button>
        ) : null}
      </div>
      {/* 押すとダイアログが出ることだけ先に言う（画面からは読み取れない）。 */}
      <p className="text-sm text-muted-foreground">フォルダは押したときに選びます。</p>
      <label className="flex w-fit items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={form.overwrite}
          disabled={converting}
          onChange={(e) => setForm({ overwrite: e.target.checked })}
        />
        フォルダに同名があれば上書きする
      </label>
      {/* **押せないときは必ず理由を出す**（UI.md §6.1）。灰色のボタンだけを置かない。
          色に頼らずアイコンを添える（§7）。 */}
      {!converting && problem !== null ? (
        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{problem}</span>
        </p>
      ) : !converting && !settled ? (
        <p className="text-sm text-muted-foreground">プレビューを作っています…</p>
      ) : null}
    </div>
  );
}
