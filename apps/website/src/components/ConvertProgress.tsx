import { ProgressLine } from "@/components/ProgressLine";
import { useConvertStore } from "@/lib/stores/convertStore";

/** 変換中の進捗だけを購読する（この画面で唯一、高頻度に再描画される部品）。 */
export function ConvertProgress() {
  const converting = useConvertStore((s) => s.status === "converting");
  const processed = useConvertStore((s) => s.progress.processed);
  const total = useConvertStore((s) => s.progress.total);
  if (!converting) return null;
  return <ProgressLine label="変換中…" processed={processed} total={total} />;
}
