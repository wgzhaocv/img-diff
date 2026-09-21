import { ProgressLine } from "@/components/ProgressLine";
import { useScanStore } from "@/lib/stores/scanStore";
import type { ScanProgress } from "@/lib/scan";

const PHASE_LABEL: Record<ScanProgress["phase"], string> = {
  enumerating: "ファイルを列挙中…",
  hash: "デコード + ハッシュ中…",
  pixel: "ピクセル照合中…",
};

/** スキャン中の進捗だけを購読する（この画面で唯一、高頻度に再描画される部品）。 */
export function ScanProgressBar() {
  const scanning = useScanStore((s) => s.status === "scanning");
  const phase = useScanStore((s) => s.progress.phase);
  const processed = useScanStore((s) => s.progress.processed);
  const total = useScanStore((s) => s.progress.total);
  if (!scanning) return null;
  return (
    <ProgressLine
      label={PHASE_LABEL[phase]}
      processed={processed}
      total={total}
      className="mx-auto max-w-2xl"
    />
  );
}
