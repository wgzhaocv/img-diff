import { Progress } from "@/components/ui/progress";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ImageSlot } from "@/components/ImageSlot";
import { CompareView } from "@/components/CompareView";
import { useCompareStore } from "@/lib/stores/compareStore";
import type { ComparePhase } from "@/lib/compare";

// フェーズ表示（「今なにをしているか」＋ 3 段の進捗）。UI.md 原則3: 派手なスピナーより線形バー + 等幅表記。
const PHASE: Record<ComparePhase, { label: string; step: number; pct: number }> = {
  decode: { label: "画像を読み込み中…", step: 1, pct: 30 },
  score: { label: "スコアを計算中（SSIM / PSNR / 差分割合）…", step: 2, pct: 65 },
  diff: { label: "差分ハイライトを生成中…", step: 3, pct: 90 },
};

export function CompareScreen() {
  const { fileA, fileB, outcome, status, phase, pick } = useCompareStore();
  const comparing = status === "comparing";

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <ScreenHeader title="2 枚の画像を見比べる">
        並べて表示・境界スライダ・ピクセル差分の重ね・<span className="num">SSIM</span> /{" "}
        <span className="num">PSNR</span> を等幅数字で。ブラウザ内で完結します。
      </ScreenHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <ImageSlot label="画像 A" file={fileA} onPick={(f) => pick("a", f)} disabled={comparing} />
        <ImageSlot label="画像 B" file={fileB} onPick={(f) => pick("b", f)} disabled={comparing} />
      </div>

      {comparing ? (
        <div className="mx-auto max-w-md space-y-2" role="status" aria-live="polite">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{PHASE[phase].label}</span>
            <span className="num">{PHASE[phase].step} / 3</span>
          </div>
          <Progress value={PHASE[phase].pct} />
          {phase === "decode" ? (
            <p className="text-xs text-muted-foreground">
              ※ 初回はエンジン（wasm-vips）の初期化で少し時間がかかります。以降は速くなります。
            </p>
          ) : null}
        </div>
      ) : null}

      {status === "done" && outcome && fileA && fileB ? (
        <CompareView outcome={outcome} fileA={fileA} fileB={fileB} />
      ) : null}

      {status === "idle" && !(fileA && fileB) ? (
        <p className="text-center text-sm text-muted-foreground">
          2 枚を読み込むと、総合判定と各種スコア・視覚比較を表示します。
        </p>
      ) : null}
    </div>
  );
}
