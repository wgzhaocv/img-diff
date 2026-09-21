import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/**
 * 進捗の 1 行（見出し + `処理済 / 全体` + バー）。
 *
 * **これを使う側は「購読を閉じ込める薄い部品」にすること。** 進捗は worker の完了ごとに
 * 更新され、実測で最大 ~580 回/秒に達する。画面本体がその値を読むと毎フレーム描き直される。
 */
export function ProgressLine({
  label,
  processed,
  total,
  className,
}: {
  label: string;
  processed: number;
  total: number;
  className?: string;
}) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <div className={cn("space-y-2", className)} role="status" aria-live="polite">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="num">
          {processed} / {total}
        </span>
      </div>
      <Progress value={pct} />
    </div>
  );
}
