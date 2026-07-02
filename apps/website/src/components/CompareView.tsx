import { useEffect, useRef, useState } from "react";
import { CheckCheck, Copy, SplitSquareHorizontal, TriangleAlert } from "lucide-react";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { useObjectUrl } from "@/lib/useObjectUrl";
import { HASH_BITS } from "schema";
import type { CompareOutcome } from "@/lib/compare";

type Tone = "same" | "near" | "diff" | "incomparable";

// 総合判定（表示専用のヒューリスティック。厳密な数値は下のメトリクスが正本）。
function verdict(o: CompareOutcome): { title: string; detail: string; tone: Tone } {
  if (o.shaEqual)
    return { title: "完全に同一のファイル", detail: "バイト単位で一致しています。", tone: "same" };
  if (o.pixelEqual)
    return {
      title: "ピクセルが完全一致",
      detail: "再エンコードや EXIF の違いだけで、画素は同一です。",
      tone: "same",
    };
  if (!o.dimsEqual)
    return {
      title: "寸法が異なります",
      detail: "サイズが違うため画素比較はできません（知覚ハッシュのみで判定）。",
      tone: "incomparable",
    };
  const ssim = o.ssim ?? 0;
  if (ssim >= 0.995)
    return { title: "ほぼ同じ画像", detail: "ごくわずかな差があります。", tone: "near" };
  if (ssim >= 0.9) return { title: "よく似た画像", detail: "細部に違いがあります。", tone: "near" };
  return { title: "異なる画像", detail: "内容が大きく異なります。", tone: "diff" };
}

const TONE_STYLE: Record<Tone, { box: string; icon: string; Icon: typeof CheckCheck }> = {
  same: { box: "border-primary/30 bg-accent", icon: "text-primary", Icon: CheckCheck },
  near: { box: "border-primary/20 bg-card", icon: "text-primary", Icon: Copy },
  diff: {
    box: "border-border bg-card",
    icon: "text-muted-foreground",
    Icon: SplitSquareHorizontal,
  },
  incomparable: {
    box: "border-warning/30 bg-warning/5",
    icon: "text-warning",
    Icon: TriangleAlert,
  },
};

function fmtPsnr(v: number): string {
  return v >= 100 ? "∞" : v.toFixed(2);
}

/// 統計セル（等幅数字・UI.md 原則3）。tone で控えめに強調（色だけに頼らずラベルで意味を出す）。
function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn("num mt-0.5 text-lg font-medium", warn ? "text-warning" : "text-foreground")}
      >
        {value}
      </div>
    </div>
  );
}

/// A/B 2 値の表示（一致なら 1 つ、相違なら "A / B"）。
function pairText(a: string, b: string): string {
  return a === b ? a : `${a} / ${b}`;
}

type Mode = "side" | "swipe" | "diff";

export function CompareView({
  outcome,
  fileA,
  fileB,
}: {
  outcome: CompareOutcome;
  fileA: File;
  fileB: File;
}) {
  const aUrl = useObjectUrl(fileA);
  const bUrl = useObjectUrl(fileB);
  const [mode, setMode] = useState<Mode>("side");
  const v = verdict(outcome);
  const { Icon, box, icon } = TONE_STYLE[v.tone];

  // diff タブは comparable のときだけ。非対応の組で diff を選んだ状態が残ったら並べて表示に落とす。
  const canDiff = Boolean(outcome.diff);
  const effectiveMode: Mode = mode === "diff" && !canDiff ? "side" : mode;

  const dims = pairText(
    `${outcome.a.width}×${outcome.a.height}`,
    `${outcome.b.width}×${outcome.b.height}`,
  );
  const dash = "—";

  return (
    <div className="space-y-6">
      {/* 総合判定 */}
      <div className={cn("flex items-start gap-3 rounded-xl border p-4", box)}>
        <Icon className={cn("mt-0.5 size-5 shrink-0", icon)} />
        <div>
          <p className="font-medium text-foreground">{v.title}</p>
          <p className="text-sm text-muted-foreground">{v.detail}</p>
        </div>
      </div>

      {/* メトリクス */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="SSIM" value={outcome.ssim != null ? outcome.ssim.toFixed(4) : dash} />
        <Stat label="PSNR (dB)" value={outcome.psnr != null ? fmtPsnr(outcome.psnr) : dash} />
        <Stat
          label="差分割合"
          value={
            outcome.pixelDiffRatio != null ? `${(outcome.pixelDiffRatio * 100).toFixed(2)}%` : dash
          }
        />
        <Stat
          label="ハミング距離"
          value={
            outcome.hammingDistance != null ? `${outcome.hammingDistance} / ${HASH_BITS}` : dash
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="寸法" value={dims} warn={!outcome.dimsEqual} />
        <Stat
          label="容量"
          value={pairText(formatBytes(outcome.a.bytes), formatBytes(outcome.b.bytes))}
        />
        <Stat label="形式" value={pairText(outcome.a.format, outcome.b.format)} />
      </div>

      {/* 視覚比較 */}
      <div className="space-y-4">
        <Tabs value={effectiveMode} onValueChange={(m) => setMode(m as Mode)}>
          <TabsList>
            <TabsTrigger value="side">並べて</TabsTrigger>
            <TabsTrigger value="swipe">スライダ</TabsTrigger>
            <TabsTrigger value="diff" disabled={!canDiff}>
              差分
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {effectiveMode === "side" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <ImagePane url={aUrl} label="A" name={fileA.name} />
            <ImagePane url={bUrl} label="B" name={fileB.name} />
          </div>
        ) : null}

        {effectiveMode === "swipe" && aUrl && bUrl ? (
          <SwipeCompare aUrl={aUrl} bUrl={bUrl} />
        ) : null}

        {effectiveMode === "diff" && outcome.diff ? (
          <>
            <DiffCanvas diff={outcome.diff} />
            <p className="text-center text-sm text-muted-foreground">
              <span className="font-medium text-diff-overlay">品紅</span> = 差分ピクセル・淡グレー =
              一致部分。
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ImagePane({ url, label, name }: { url: string | null; label: string; name: string }) {
  return (
    <figure className="space-y-2">
      <div className="checker aspect-video overflow-hidden rounded-md border border-border">
        {url ? (
          <img src={url} alt={`${label}: ${name}`} className="size-full object-contain" />
        ) : null}
      </div>
      <figcaption className="truncate text-center text-sm text-muted-foreground" title={name}>
        <span className="font-medium text-foreground">{label}</span> · {name}
      </figcaption>
    </figure>
  );
}

/// A/B の before/after スライダ（react-compare-slider）。境界線上のハンドルをドラッグ、
/// 矢印キーでも操作可（ライブラリがタッチ/キーボード/ハンドル描画を担う＝自前実装しない）。
/// object-contain で画像全体を見せ、透過は市松背景で示す。主色 Teal をハンドル/線に反映。
function SwipeCompare({ aUrl, bUrl }: { aUrl: string; bUrl: string }) {
  return (
    <div className="relative mx-auto h-[min(60vh,28rem)] w-full overflow-hidden rounded-md border border-border">
      <ReactCompareSlider
        className="checker size-full"
        itemOne={<ReactCompareSliderImage src={aUrl} alt="A" style={{ objectFit: "contain" }} />}
        itemTwo={<ReactCompareSliderImage src={bUrl} alt="B" style={{ objectFit: "contain" }} />}
        style={{ height: "100%" }}
      />
      <span className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-foreground/70 px-1.5 py-0.5 text-xs font-medium text-background">
        A
      </span>
      <span className="pointer-events-none absolute right-2 top-2 z-10 rounded bg-foreground/70 px-1.5 py-0.5 text-xs font-medium text-background">
        B
      </span>
    </div>
  );
}

/// 差分ハイライト RGBA を canvas に描く（等倍で putImageData → CSS で縮小表示）。
function DiffCanvas({ diff }: { diff: NonNullable<CompareOutcome["diff"]> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = diff.width;
    canvas.height = diff.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const data = new Uint8ClampedArray(
      diff.rgba.buffer,
      diff.rgba.byteOffset,
      diff.rgba.byteLength,
    );
    ctx.putImageData(new ImageData(data, diff.width, diff.height), 0, 0);
  }, [diff]);
  return (
    <div className="mx-auto max-h-[min(60vh,28rem)] w-fit max-w-full overflow-auto rounded-md border border-border">
      <canvas ref={ref} className="block h-auto max-w-full" />
    </div>
  );
}
