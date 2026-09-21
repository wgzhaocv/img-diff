import { useRef, useState } from "react";
import { Check, Download, Images, Replace, ScanSearch, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { errText } from "@/lib/format";
import { cn } from "@/lib/utils";

// **OG 画像（1200×630）を作るためだけの画面。** 公開ナビからは辿れない（`/og` を直接開く）。
// 画像を静的ファイルとして持つ以上、作り直せる形も一緒に置いておく —— でないと
// 「文言を直したいが元データが無い」になる。
//
// 画面に出ている `#og-sheet` を snapdom がそのまま写すので、**見えている物が出力**。
// 検算のために枠の外に実寸を出してある（1200×630 から動いたら気づけるように）。
//
// snapdom は**この画面を開いたときだけ**読み込む（`App.tsx` の `lazy`）。
// 使うのは作り直すときだけなので、本番の bundle に載せる理由が無い。

/** OpenGraph の標準寸法。ここを変えたら `index.html` の og:image:width/height も変える。 */
const OG_W = 1200;
const OG_H = 630;

/** 画面に収める倍率。実寸で置くと横に溢れるので、**見るときだけ**縮める。 */
const PREVIEW_SCALE = 0.6;

type Mode = { label: string; Icon: LucideIcon };

// `ModeTabs` と同じ 3 つ。あちらは経路を持つので流用せず、文言だけ合わせる。
const MODES: Mode[] = [
  { label: "重複を探す", Icon: ScanSearch },
  { label: "2枚を比較", Icon: Images },
  { label: "形式を変換", Icon: Replace },
];

/**
 * 網格の 9 枡。`dup` の 2 枡が「見つかった重複」= リング + チェック（UI.md §6:
 * 選択は主色の 2px リング。**色だけに頼らずチェック印も付ける**）。
 * 中身は実写を持ち込まず、面のトーンだけで「別々の画像」を表す（§8: 飾りを足さない）。
 */
const CELLS = [
  { tone: "bg-accent", dup: true },
  { tone: "bg-muted", dup: false },
  { tone: "bg-secondary", dup: false },
  { tone: "bg-muted", dup: false },
  { tone: "bg-accent", dup: true },
  { tone: "bg-secondary", dup: false },
  { tone: "bg-secondary", dup: false },
  { tone: "bg-muted", dup: false },
  { tone: "bg-muted", dup: false },
];

export function OgScreen() {
  const sheet = useRef<HTMLDivElement>(null);
  const zoom = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    const el = sheet.current;
    const box = zoom.current;
    if (!el || !box) return;
    setSaving(true);
    // **撮る瞬間だけ実寸に戻す。** snapdom は要素を測ってから写すので、縮めたまま撮ると
    // 箱ごと縮んだ寸法（624×328）で写る。外枠が `overflow-hidden` なので、
    // 戻している間も溢れは切られるだけ（スクロールバーは出ない）。
    const shrunk = box.style.transform;
    try {
      box.style.transform = "none";
      // レイアウトを確定させてから測らせる。
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      // **寸法は明示して渡す。** 既定は CSS 実寸だが、頁を拡大していると狂う。
      const { snapdom } = await import("@zumer/snapdom");
      await snapdom.download(el, {
        width: OG_W,
        height: OG_H,
        format: "png",
        filename: "og-image",
      });
    } catch (e) {
      toast.error("書き出せませんでした", { description: errText(e) });
    } finally {
      box.style.transform = shrunk;
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">OG 画像</h1>
        <span className="num text-sm text-muted-foreground">
          {OG_W}×{OG_H}
        </span>
        <Button onClick={() => void save()} disabled={saving} className="ml-auto gap-1.5">
          <Download className="size-4" />
          {saving ? "書き出し中…" : "png で保存"}
        </Button>
      </div>
      {/* 明暗はヘッダの切替に従う（見えている物がそのまま出る）。既定は亮色（UI.md §1）。 */}
      <p className="text-sm text-muted-foreground">
        ヘッダのテーマ切替で明暗を選んでから保存します（見えているものがそのまま出ます）。
      </p>

      {/* 枠は**縮めた寸法ぴったり**にして `overflow-hidden`。こうしておけば、
          `save` が撮る瞬間に実寸へ戻しても溢れは切られるだけで、スクロールバーが出ない。 */}
      <div
        className="overflow-hidden rounded-lg border border-border"
        style={{ width: OG_W * PREVIEW_SCALE, height: OG_H * PREVIEW_SCALE }}
      >
        <div
          ref={zoom}
          className="origin-top-left"
          style={{ transform: `scale(${PREVIEW_SCALE})` }}
        >
          <OgSheet ref={sheet} />
        </div>
      </div>
    </div>
  );
}

function OgSheet({ ref }: { ref: React.Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      id="og-sheet"
      style={{ width: OG_W, height: OG_H }}
      className="flex flex-col bg-background p-[72px] text-foreground"
    >
      <div className="flex items-center gap-4">
        <Logo className="size-14" />
        <span className="text-[56px] font-semibold leading-none tracking-tight">img-diff</span>
      </div>

      {/* 中段が縦の余りを全部取り、左右それぞれを**その中で上下中央**に置く。
          `justify-between` を外側に掛けるとロゴの下に死んだ空きができる。 */}
      <div className="flex flex-1 items-center justify-between gap-16">
        <div className="space-y-8">
          <p className="text-[52px] font-semibold leading-[1.25] tracking-tight">
            重複・類似画像を、
            <br />
            ブラウザだけで。
          </p>
          <div className="flex gap-3">
            {MODES.map(({ label, Icon }) => (
              <span
                key={label}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-2 text-[20px] text-secondary-foreground"
              >
                <Icon className="size-5 text-primary-text" />
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* 「重複が 2 枚見つかった網格」。何をする道具かを一目で。
            件数や容量の文字は添えない —— 印の付いた 2 枡が既にそう言っているし、
            下辺の行とくっついて読みにくくなる。 */}
        <div className="grid grid-cols-3 gap-4">
          {CELLS.map((cell, i) => (
            <div
              key={i}
              className={cn(
                "relative size-[104px] rounded-md border border-border",
                cell.tone,
                cell.dup && "ring-2 ring-primary ring-offset-2 ring-offset-background",
              )}
            >
              {cell.dup ? (
                <span className="absolute -right-2 -top-2 flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="size-4" strokeWidth={3} />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <p className="text-[20px] text-muted-foreground">
        すべてブラウザ内で処理。画像はどこにも送信されません。
      </p>
    </div>
  );
}
