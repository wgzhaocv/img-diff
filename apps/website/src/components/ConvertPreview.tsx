import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Loader2, Maximize, Minimize } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isBrowserRenderable } from "@/lib/convertControls";
import { outPathFor } from "@/lib/convert";
import { errText, formatBytes } from "@/lib/format";
import { baseNameOf } from "@/lib/imagePaths";
import { IMAGE_FRAME } from "@/components/Thumb";
import { cn } from "@/lib/utils";
import { useObjectUrl } from "@/lib/useObjectUrl";
import { Skeleton } from "@/components/ui/skeleton";
import { previewKey, useConvertStore } from "@/lib/stores/convertStore";

// 今の設定で**実際に変換して**結果を見せる（推定値ではない）。
// 切り抜きの位置も余白の色も、言葉で説明するより見た方が早い。
//
// **この画面に「実行」は無い。** ここに出ている結果が成果物そのものなので、
// `保存` がこの機能の主操作 —— ブラウザの既定のダウンロード先へそのまま落ちる
// （選択ダイアログを出さない＝権限の話が一切発生しない）。
//
// 性能のための約束が 3 つある（ストア側で担保）:
//   1. 入力が止まってから 300ms 待つ（スライダを掴んで動かしても走らない）
//   2. 同時に走るのは**常に 1 枚**。走行中の要求は「最後の 1 回」だけ覚えて後でやり直す
//   3. 原寸が届くまで動かさない（DESIGN §7.2）

/** 入力が止まったとみなすまで（ScanScreen の閾値入力と同じ作法）。 */
const DEBOUNCE_MS = 300;

export function ConvertPreview() {
  const previewAsPng = useConvertStore((s) => s.previewAsPng);
  const [copied, setCopied] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const path = useConvertStore((s) => s.source?.path);
  // **出力に効く入力だけ**を見張る（フォームの他の欄を触っても作り直さない）。
  const key = useConvertStore(previewKey);
  const renderPreview = useConvertStore((s) => s.renderPreview);
  const preview = useConvertStore((s) => s.preview);
  const rendering = useConvertStore((s) => s.previewRendering);
  const loadingEngine = useConvertStore((s) => s.engine === "loading");
  const failure = useConvertStore((s) => s.previewError);
  const before = useConvertStore((s) => s.info);
  const reset = useConvertStore((s) => s.reset);

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
  // **今の入力から作った結果だけ**を「結果」として扱う。path だけで突き合わせると、
  // 設定を変えた直後や失敗したときに古い絵が残り、それを「今の結果」として保存・コピーできてしまう。
  const shown = preview?.key === key ? preview : null;
  // 失敗の理由も**今の入力に対するもの**だけ出す（設定を変えたら前の理由は消える）。
  const error = failure?.key === key ? failure.message : null;
  // **素通しの出力寸法は原寸そのもの**（デコードしていないので `preview` は持っていない）。
  // 原寸がまだ届いていない／読めなかったときは、寸法の区画ごと出さない。
  const outWidth = shown?.passedThrough ? (before?.width ?? 0) : (shown?.width ?? 0);
  const outHeight = shown?.passedThrough ? (before?.height ?? 0) : (shown?.height ?? 0);
  const outDims = outWidth > 0 ? `${outWidth}×${outHeight}` : "";
  // **絵だけは前のものを残す**（暗くして・見出しは「生成中…」）。avif は 1 枚に数秒かかるので、
  // 作り直すたびに枠を空にすると固まったように見える。数字とボタンは `shown` にしか従わないので、
  // 古い結果を保存・コピーできてしまうことは無い。**理由が出たら引っ込める**
  // （「書き出せません」の横に絵が残っていたら嘘になる）。
  // `previewRendering` を条件にしては駄目 —— 入力が止まるのを待つ 300ms の間はまだ false なので、
  // そこで一瞬だけ枠が空になる。
  const pictured = shown ?? (error == null ? preview : null);
  const afterUrl = useObjectUrl(pictured?.blob ?? null);
  // **保存リンクの href は絵とは別に採る。** `useObjectUrl` は effect で URL を張り替えるので、
  // 新しい結果が届いた最初の 1 フレームは `shown` だけが新しく `afterUrl` はまだ古い blob を指す。
  // 1 つで兼ねると、その 1 フレームだけ「新しい名前で古い画像を保存する」リンクになる
  // （前の絵を残すようにして初めて届くようになった隙間 —— 以前は url も null だったので
  //   ボタン自体が出ていなかった）。
  const savableUrl = useObjectUrl(shown?.blob ?? null);
  const renderable = pictured != null && isBrowserRenderable(pictured.format);
  // **保存できるのは「今の鍵の結果」だけ。** url が blob に追いつくまでは押せない。
  const ready = shown != null && savableUrl != null;

  if (path == null) return null;
  const name = baseNameOf(path);

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">プレビュー</h2>
        <span className="ml-auto truncate text-xs text-muted-foreground" title={path}>
          {name}
        </span>
        <Button variant="ghost" size="sm" onClick={() => reset()}>
          選び直す
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <figure className="space-y-1">
          <div className={cn(IMAGE_FRAME, "aspect-square")}>
            {beforeUrl ? (
              <img src={beforeUrl} alt={`変換前: ${name}`} className="size-full object-contain" />
            ) : (
              <Skeleton className="size-full rounded-none" />
            )}
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
              // **絵そのものが拡大の入口。** 押せるのは今の結果が出ているときだけ
              // （作り直している間の薄い絵を拡大しても、それは今の結果ではない）。
              <button
                type="button"
                disabled={!ready}
                onClick={() => setZoomed(true)}
                aria-label={`拡大して見る: ${name}`}
                className="size-full cursor-zoom-in disabled:cursor-default"
              >
                <img
                  src={afterUrl}
                  alt={`変換後: ${name}`}
                  className={cn("size-full object-contain", pictured !== shown && "opacity-50")}
                />
              </button>
            ) : null}
            {/* 絵が無い間だけ。**理由が出ているときは出さない** ——
                「書き出せません」の横で光っていたら、まだ作っているように見える。 */}
            {!afterUrl && error == null && (loadingEngine || rendering) ? (
              <Skeleton className="size-full rounded-none" />
            ) : null}
            {afterUrl && !renderable ? (
              // wasm-vips は書けてもブラウザが描けない形式（jxl / tiff / ppm）。
              // 絵は諦めて、寸法とサイズだけ正しく見せる。
              <p className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
                この形式はブラウザで表示できません
              </p>
            ) : null}
          </div>
          {/* **何を待っているのかを言う**（UI.md §6）。エンジンの読み込みと生成は
              待ち時間の性格が違う（前者は約 11.9MB のダウンロード・一度だけ）。
              回る物は**この文字の側に付ける** —— 枠は既に光っているので、そこへ重ねると
              同じ場所で 2 つの動きがぶつかる。 */}
          <figcaption className="flex items-center gap-1.5 text-xs text-muted-foreground">
            変換後
            {loadingEngine || rendering ? (
              <>
                <Loader2 className="size-3 shrink-0 animate-spin text-primary" aria-hidden="true" />
                <span>{loadingEngine ? "エンジンを読み込み中…" : "生成中…"}</span>
              </>
            ) : null}
          </figcaption>
          {error != null ? (
            <div className="text-xs text-warning">{error}</div>
          ) : shown ? (
            <>
              <div className="num text-xs text-muted-foreground">
                {outDims ? `${outDims} · ` : ""}
                {formatBytes(shown.bytes)} · {shown.format}
              </div>
              {shown.passedThrough ? (
                // 何も変える指定が無い＝元のファイルがそのままコピーされる（SPEC §5.4 規則 4）。
                <div className="text-xs text-muted-foreground">変換なし（そのままコピー）</div>
              ) : null}
            </>
          ) : null}
        </figure>
      </div>

      <PreviewActions
        ready={ready}
        savableUrl={savableUrl}
        fileName={ready ? outPathFor(name, shown.format) : ""}
        format={shown?.format}
        copying={copying}
        copied={copied}
        onCopy={() => void copyImage()}
      />

      {/* 押した絵を大きく見る。元の寸法で出すと画面から溢れるので枠に収め、
       **全画面**だけは要求できるようにしておく（画素を確かめたいときのため）。 */}
      <ZoomDialog
        open={zoomed}
        onOpenChange={setZoomed}
        name={name}
        url={ready ? savableUrl : null}
        dims={outDims}
        actions={
          <PreviewActions
            ready={ready}
            savableUrl={savableUrl}
            fileName={ready ? outPathFor(name, shown.format) : ""}
            format={shown?.format}
            copying={copying}
            copied={copied}
            onCopy={() => void copyImage()}
          />
        }
      />
    </section>
  );
}

/**
 * 保存とコピーの 1 行。**プレビューの下と拡大ダイアログの中で同じ物を使う**
 * （別々に書くと「ダイアログからだと違う名前で落ちる」類が生まれる）。
 *
 * **ボタンは消さずに無効化する**（UI.md §6.1）。作り直している間に行だけ消えると
 * 画面が跳ね、押そうとした手が空を切る。
 */
function PreviewActions({
  ready,
  savableUrl,
  fileName,
  format,
  copying,
  copied,
  onCopy,
}: {
  ready: boolean;
  savableUrl: string | null;
  fileName: string;
  format: string | undefined;
  copying: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* **これが主操作。** 行き先はブラウザの既定のダウンロード先で、
          保存ダイアログもフォルダ選択も出さない。
          **無効時は素の `button disabled` を描く** —— `asChild` に `disabled` を渡すと
          Radix Slot が子へ透過して `<span disabled="">` になり、無効な DOM のうえ
          `:disabled` に当たらないので見た目が押せるままになる。 */}
      {ready && savableUrl ? (
        <Button asChild>
          <a href={savableUrl} download={fileName} className="gap-1.5">
            <Download className="size-4" />
            保存
          </a>
        </Button>
      ) : (
        <Button disabled className="gap-1.5">
          <Download className="size-4" />
          保存
        </Button>
      )}
      <Button
        variant="outline"
        className="gap-1.5"
        onClick={onCopy}
        disabled={!ready || copying}
        // 貼り付け先が欲しいのは絵であって形式ではない。ただし黙って替えない。
        title={
          format === "png"
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
  );
}

/**
 * 変換後の絵を大きく見るダイアログ。
 *
 * **全画面は要求できるようにしておく** —— 画素を確かめたいときに枠の中では足りない。
 * `requestFullscreen` は利用者の操作の中でしか通らないので、ボタンから直接呼ぶ。
 * 実際に全画面かどうかは `document.fullscreenElement` を見張る（Esc で抜けられたり、
 * OS 側から解除されることがあるので、自前の真偽値を信じない）。
 */
function ZoomDialog({
  open,
  onOpenChange,
  name,
  url,
  dims,
  actions,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  name: string;
  url: string | null;
  dims: string;
  actions: React.ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const sync = (): void => setFull(document.fullscreenElement != null);
    document.addEventListener("fullscreenchange", sync);
    sync();
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await frame.current?.requestFullscreen();
    } catch (e) {
      // 権限や埋め込み条件で拒否されることがある（iframe の allowfullscreen 無し等）。
      toast.error("全画面にできませんでした", { description: errText(e) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 閉じる手段は 1 つに揃える（右上の × は出さず、下の行の「閉じる」だけ）。 */}
      <DialogContent showCloseButton={false} className="max-w-[min(96vw,1400px)] gap-3">
        <DialogHeader>
          <DialogTitle className="truncate text-sm font-medium">{name}</DialogTitle>
          <DialogDescription className="num text-xs">{dims}</DialogDescription>
        </DialogHeader>
        {/* **全画面にするのはこの枠だけ。** ダイアログ全体を対象にすると、`DialogContent` の
            位置の効用類（`fixed top-[50%] translate-*`）と競合して画面の隅に寄る
            （実機で確認）。位置を持たない裸の要素なら、ブラウザの `:fullscreen` 既定が
            そのまま効く。全画面では**絵だけを中央に**置き、市松も枠線も出さない
            （出口は Esc。ブラウザが「press esc」と自分で案内する）。
            普段は市松の上に収めるので、透過も等倍でない縮小も分かる。 */}
        <div ref={frame} className={cn(IMAGE_FRAME, "zoom-frame flex items-center justify-center")}>
          {url ? (
            <img
              src={url}
              alt={`変換後: ${name}`}
              className="max-h-full max-w-full object-contain"
            />
          ) : null}
        </div>
        <DialogFooter className="sm:justify-start">
          {actions}
          <Button variant="outline" className="gap-1.5" onClick={() => void toggleFullscreen()}>
            {full ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
            {full ? "全画面をやめる" : "全画面"}
          </Button>
          <DialogClose asChild>
            <Button variant="ghost">閉じる</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
