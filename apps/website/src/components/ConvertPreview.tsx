import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { isBrowserRenderable } from "@/lib/convertControls";
import { outPathFor } from "@/lib/convert";
import { errText, formatBytes } from "@/lib/format";
import { baseNameOf } from "@/lib/imagePaths";
import { IMAGE_FRAME } from "@/components/Thumb";
import { cn } from "@/lib/utils";
import { useObjectUrl } from "@/lib/useObjectUrl";
import { previewKey, representativePath, useConvertStore } from "@/lib/stores/convertStore";

// 今の設定で**実際に 1 枚変換して**結果を見せる（推定値ではない）。
// 切り抜きの位置も余白の色も、言葉で説明するより見た方が早い。
//
// 性能のための約束が 3 つある（ストア側で担保）:
//   1. 入力が止まってから 300ms 待つ（スライダを掴んで動かしても走らない）
//   2. 同時に走るのは**常に 1 枚**。走行中の要求は「最後の 1 回」だけ覚えて後でやり直す
//   3. 本番の変換中は走らせない（同じワーカープールを奪い合わない）

/** 入力が止まったとみなすまで（ScanScreen の閾値入力と同じ作法）。 */
const DEBOUNCE_MS = 300;

export function ConvertPreview() {
  const previewAsPng = useConvertStore((s) => s.previewAsPng);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const path = useConvertStore(representativePath);
  // **出力に効く入力だけ**を見張る（保存先や上書きを触っても作り直さない）。
  const key = useConvertStore(previewKey);
  const renderPreview = useConvertStore((s) => s.renderPreview);
  const preview = useConvertStore((s) => s.preview);
  const rendering = useConvertStore((s) => s.previewRendering);
  const failure = useConvertStore((s) => s.previewError);
  const before = useConvertStore((s) => (path == null ? undefined : s.sourceInfo.get(path)));

  useEffect(() => {
    const t = setTimeout(() => void renderPreview(), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key, renderPreview]);

  // アンマウント時に復帰タイマを掃除（unmount 後の setState を避ける）。
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  /**
   * 変換結果をクリップボードへ。**png への包み直しは `ClipboardItem` に Promise のまま渡す** ——
   * 先に await すると利用者の操作（transient activation）が切れて、ブラウザが書き込みを拒否する。
   */
  async function copyImage(): Promise<void> {
    // png への包み直しは実測で最大 ~700ms（4000×3000 の実写 → 31MB の png）。
    // 無言で待たせない（UI.md §3「速さがブランド」＝待つときは待つと言う）。
    setCopying(true);
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": previewAsPng() })]);
      setCopied(true);
      toast.success("画像をコピーしました");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // 非対応ブラウザ・権限拒否・png 化の失敗。保存の方は使えるのでそちらへ誘導する。
      toast.error("コピーできませんでした", { description: errText(e) });
    } finally {
      setCopying(false);
    }
  }

  const beforeUrl = useObjectUrl(before?.thumb ?? null);
  // **今の入力から作った結果だけ**を出す。path だけで突き合わせると、設定を変えた直後や
  // 失敗したときに古い絵が残り、それを「今の結果」として保存・コピーできてしまう。
  const shown = preview?.key === key ? preview : null;
  // 失敗の理由も**今の入力に対するもの**だけ出す（設定を変えたら前の理由は消える）。
  const error = failure?.key === key ? failure.message : null;
  const afterUrl = useObjectUrl(shown?.blob ?? null);
  const renderable = shown != null && isBrowserRenderable(shown.format);

  if (path == null) return null;
  const name = baseNameOf(path);

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">プレビュー</h2>
        <span className="truncate text-xs text-muted-foreground" title={path}>
          {name}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <figure className="space-y-1">
          <div className={cn(IMAGE_FRAME, "aspect-square")}>
            {beforeUrl ? (
              <img src={beforeUrl} alt={`変換前: ${name}`} className="size-full object-contain" />
            ) : null}
          </div>
          <figcaption className="text-xs text-muted-foreground">変換前</figcaption>
          {before && before.width > 0 ? (
            <div className="num text-xs text-muted-foreground">
              {before.width}×{before.height} · {formatBytes(before.bytes)}
            </div>
          ) : null}
        </figure>

        <figure className="space-y-1">
          <div className={cn(IMAGE_FRAME, "relative aspect-square")}>
            {afterUrl && renderable ? (
              <img
                src={afterUrl}
                alt={`変換後: ${name}`}
                className={cn("size-full object-contain", rendering && "opacity-50")}
              />
            ) : null}
            {afterUrl && !renderable ? (
              // wasm-vips は書けてもブラウザが描けない形式（jxl / tiff / ppm）。
              // 絵は諦めて、寸法とサイズだけ正しく見せる。
              <p className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
                この形式はブラウザで表示できません
              </p>
            ) : null}
          </div>
          <figcaption className="text-xs text-muted-foreground">
            変換後{rendering ? "（生成中…）" : null}
          </figcaption>
          {error != null ? (
            <div className="text-xs text-warning">{error}</div>
          ) : shown ? (
            <>
              <div className="num text-xs text-muted-foreground">
                {shown.width}×{shown.height} · {formatBytes(shown.bytes)} · {shown.format}
              </div>
              {shown.passedThrough ? (
                // 何も変える指定が無い＝元のファイルがそのままコピーされる（SPEC §5.4 規則 4）。
                <div className="text-xs text-muted-foreground">変換なし（そのままコピー）</div>
              ) : null}
            </>
          ) : null}
        </figure>
      </div>

      {afterUrl && shown ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={afterUrl} download={outPathFor(name, shown.format)} className="gap-1.5">
              <Download className="size-4" />
              保存
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void copyImage()}
            disabled={copying}
            // 貼り付け先が欲しいのは絵であって形式ではない。ただし黙って替えない。
            title={
              shown.format === "png"
                ? undefined
                : "クリップボードは png のみ受け取れます（画素はそのまま png で渡します）"
            }
          >
            {copying ? (
              <Loader2 className="size-4 animate-spin" />
            ) : copied ? (
              <Check className="size-4 text-primary" />
            ) : (
              <Copy className="size-4" />
            )}
            {copying ? "コピー中…" : "コピー"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
