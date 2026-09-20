import { Progress } from "@/components/ui/progress";
import { useConvertStore } from "@/lib/stores/convertStore";

/**
 * 変換中の進捗だけを描く。**この画面で唯一、高頻度に再描画される部品。**
 *
 * `onProgress` は 1 件終わるごとに呼ばれ、実測で最大 ~580 回/秒に達する
 * （ストア側で raf に合流させてもフレーム毎＝60 回/秒）。数値と幅しか変わらないので、
 * **購読をここへ閉じ込める**（親が進捗を読むと画面全体が毎フレーム描き直される）。
 * 選ぶのは数値そのものにする —— `progress` オブジェクトは毎回新しい参照になるため。
 */
export function ConvertProgress() {
  const converting = useConvertStore((s) => s.status === "converting");
  const processed = useConvertStore((s) => s.progress.processed);
  const total = useConvertStore((s) => s.progress.total);
  if (!converting) return null;

  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">変換中…</span>
        <span className="num">
          {processed} / {total}
        </span>
      </div>
      <Progress value={pct} />
    </div>
  );
}
