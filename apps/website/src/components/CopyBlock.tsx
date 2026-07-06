import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// コピー可能なコマンド表示（install ページの CLI / skill コマンド用）。
// UI.md: コマンドは等幅（font-mono）・冷灰の面（bg-secondary）・最小の影。コピーは色だけに頼らず
// アイコン（Copy→Check）+ トースト文言で伝える。長いコマンドは横スクロール（ボタンには被らない）。
type Props = {
  /** 表示・コピー対象のコマンド文字列。 */
  command: string;
  /** 任意の見出し（例「PowerShell（推奨）」）。 */
  label?: string;
};

export function CopyBlock({ command, label }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // アンマウント時に復帰タイマを掃除（unmount 後の setState を避ける）。
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success("コピーしました");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // クリップボード非対応・権限拒否など。手動選択にフォールバックしてもらう。
      toast.error("コピーできませんでした（コマンドを選択してコピーしてください）");
    }
  }

  return (
    <div className="space-y-1.5">
      {label ? <p className="text-sm font-medium text-foreground">{label}</p> : null}
      <div className="relative">
        <pre className="overflow-x-auto rounded-md bg-secondary py-2 pr-11 pl-3 font-mono text-sm text-secondary-foreground">
          {command}
        </pre>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute top-1.5 right-1.5 bg-secondary"
          aria-label={
            copied ? "コピーしました" : label ? `${label}のコマンドをコピー` : "コマンドをコピー"
          }
          onClick={() => void copy()}
        >
          {copied ? <Check className="text-primary" /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}
