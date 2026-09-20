import { useMemo } from "react";
import { AlertCircle, Replace } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resolveSink } from "@/lib/convertSinks";
import { resolveOptions, useConvertStore } from "@/lib/stores/convertStore";

// 実行・中断と、**実行できない理由**の表示。
// 出力先を決める判断（入力フォルダを潰さない等）は lib/convertSinks の resolveSink に在る。

/** zip 出力のファイル名。 */
const ZIP_NAME = "imgdiff-converted.zip";

export function ConvertRunBar() {
  const sources = useConvertStore((s) => s.sources);
  const form = useConvertStore((s) => s.form);
  const inputRoot = useConvertStore((s) => s.inputRoot);
  const converting = useConvertStore((s) => s.status === "converting");
  const run = useConvertStore((s) => s.run);
  const cancel = useConvertStore((s) => s.cancel);
  const validate = useConvertStore((s) => s.validate);
  const validateCollisions = useConvertStore((s) => s.validateCollisions);

  // 実行できない理由は**押す前に**出す（UI.md §6.1「送信するまで黙っている形にしない」）。
  // 出力名の衝突検査だけは全件を舐めるので、**それが変わり得る入力にだけ**結び付ける
  // （文字を 1 つ打つたび・スライダを動かすたびに数千件を再走査しない）。
  const collision = useMemo(() => validateCollisions(), [sources, form.format, validateCollisions]);
  const problem = useMemo(() => validate() ?? collision, [form, sources, validate, collision]);

  /**
   * 「変換する」。**picker は resolveSink が開く。ここから同期で呼ぶ** —— 先に await すると
   * transient activation が切れてブラウザに拒否される。
   */
  async function start(): Promise<void> {
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
    const choice = await resolveSink(form, inputRoot, ZIP_NAME);
    if (choice.kind === "cancelled") return;
    if (choice.kind === "error") {
      toast.error(choice.title, { description: choice.description });
      return;
    }
    await run(choice.sink, resolved.options);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Button
          onClick={() => void start()}
          disabled={converting || problem !== null}
          className="gap-1.5"
        >
          <Replace className="size-4" />
          変換する
        </Button>
        {converting ? (
          <Button variant="outline" onClick={cancel}>
            中断
          </Button>
        ) : null}
      </div>
      {/* 色だけに頼らずアイコンを添える（UI.md §7）。 */}
      {problem !== null && !converting ? (
        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{problem}</span>
        </p>
      ) : null}
    </div>
  );
}
