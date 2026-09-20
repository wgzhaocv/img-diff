import { formatBytes } from "@/lib/format";
import { useConvertStore } from "@/lib/stores/convertStore";

/** 変換が終わったときの集計と、失敗の内訳。終わるまでは何も描かない。 */
export function ConvertResult() {
  const done = useConvertStore((s) => s.status === "done");
  const stats = useConvertStore((s) => s.stats);
  const items = useConvertStore((s) => s.items);
  if (!done || !stats) return null;

  const failed = items.filter((i) => i.status === "failed");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          変換 <span className="num text-foreground">{stats.converted}</span>
        </span>
        <span className="text-muted-foreground">
          飛ばした <span className="num">{stats.skipped}</span>
        </span>
        <span className={stats.failed > 0 ? "text-destructive" : "text-muted-foreground"}>
          失敗 <span className="num">{stats.failed}</span>
        </span>
        <span className="text-muted-foreground">
          <span className="num">{stats.elapsedMs}</span> ms
        </span>
      </div>
      {failed.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {failed.slice(0, 20).map((i) => (
            <li key={i.src} className="text-muted-foreground">
              <span className="font-mono text-foreground">{i.src}</span> — {i.error}
            </li>
          ))}
        </ul>
      ) : null}
      {stats.converted > 0 ? (
        <p className="text-sm text-muted-foreground">
          出力{" "}
          <span className="num text-foreground">
            {formatBytes(items.reduce((n, i) => n + i.bytes, 0))}
          </span>
        </p>
      ) : null}
    </div>
  );
}
