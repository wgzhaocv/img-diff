import { useEffect, useRef, useState } from "react";
import { FolderOpen, Layers, Loader2, ScanLine, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { DropZone } from "@/components/DropZone";
import { ScreenHeader } from "@/components/ScreenHeader";
import type { HashResponse } from "@/lib/hashTypes";
import { scanFiles, type ScanProgress } from "@/lib/scan";
import { defaultPoolSize, HashPool } from "@/lib/workerPool";

const POOL_SIZE = defaultPoolSize();

const FEATURES = [
  {
    icon: ScanLine,
    title: "3 段の厳密度",
    body: "完全一致・ピクセル一致・見た目が近い（知覚ハッシュ）で絞り込み。",
  },
  {
    icon: Layers,
    title: "グループで整理",
    body: "重複をまとめ、残す 1 枚を自動選定。削減できる容量も表示。",
  },
  {
    icon: Trash2,
    title: "安全に削除",
    body: "既定はドライラン。実削除はゴミ箱送りのみで、いつでも復元可能。",
  },
];

type Status = "idle" | "scanning" | "done";

export function ScanScreen() {
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<ScanProgress>({ processed: 0, total: 0 });
  const [records, setRecords] = useState<HashResponse[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);

  const poolRef = useRef<HashPool | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const runningRef = useRef(false); // 走行中の二重起動を防ぐ（stale closure 回避のため ref）。
  const abortedRef = useRef(false); // アンマウント後に setState/toast しないためのフラグ。

  // フォルダ選択にする（webkitdirectory は JSX 型に無いので属性で付与）。
  useEffect(() => {
    inputRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  // アンマウント時にワーカーを解放（走行中の Promise は terminate が reject する）。
  useEffect(() => {
    return () => {
      abortedRef.current = true;
      poolRef.current?.terminate();
      poolRef.current = null;
    };
  }, []);

  function getPool(): HashPool {
    if (!poolRef.current) poolRef.current = new HashPool(POOL_SIZE);
    return poolRef.current;
  }

  async function handleFiles(files: File[]): Promise<void> {
    if (runningRef.current) return; // 走行中の再スキャン/ドロップは無視。
    runningRef.current = true;
    setStatus("scanning");
    setRecords([]);
    setProgress({ processed: 0, total: 0 });
    const start = performance.now();
    try {
      const recs = await scanFiles(files, getPool(), POOL_SIZE, (p) => {
        if (!abortedRef.current) setProgress(p);
      });
      if (abortedRef.current) return;
      if (recs.length === 0) {
        toast.info("対象の画像が見つかりませんでした", {
          description: "jpg / png / webp / heic / avif / svg などを含むフォルダを選んでください。",
        });
        setStatus("idle");
        return;
      }
      setRecords(recs);
      setElapsedMs(Math.round(performance.now() - start));
      setStatus("done");
    } catch (e) {
      if (abortedRef.current) return;
      toast.error("スキャンに失敗しました", {
        description: e instanceof Error ? e.message : String(e),
      });
      setStatus("idle");
    } finally {
      runningRef.current = false;
    }
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = ""; // 同じフォルダを再選択できるように。
    if (files.length > 0) void handleFiles(files);
  }

  const scanning = status === "scanning";
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const failed = records.filter((r) => r.error).length;
  const ok = records.length - failed;

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <ScreenHeader
        title="フォルダ内の重複・類似画像を探す"
        badge={
          <Badge variant="secondary" className="gap-1.5">
            <ShieldCheck className="size-3.5 text-primary" />
            ブラウザ内で完結・画像は送信しない
          </Badge>
        }
      >
        数百〜数千枚から、完全一致・ピクセル一致・見た目が近い画像をグループにまとめます。
      </ScreenHeader>

      <input ref={inputRef} type="file" multiple hidden onChange={onInputChange} />

      <DropZone
        icon={<FolderOpen className="size-6" />}
        title="フォルダをドラッグ、または選択"
        hint="対応: Chromium 系ブラウザ（フォルダ権限）。ファイルのドロップにも対応。"
        onFiles={(files) => void handleFiles(files)}
      >
        <Button onClick={() => inputRef.current?.click()} disabled={scanning} className="gap-1.5">
          {scanning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FolderOpen className="size-4" />
          )}
          {scanning ? "処理中…" : "フォルダを選ぶ"}
        </Button>
      </DropZone>

      {scanning ? (
        <div className="space-y-2" role="status" aria-live="polite">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>デコード + ハッシュ中…</span>
            <span className="num">
              {progress.processed} / {progress.total}
            </span>
          </div>
          <Progress value={pct} />
        </div>
      ) : null}

      {status === "done" ? (
        <ScanResults records={records} ok={ok} failed={failed} elapsedMs={elapsedMs} />
      ) : null}

      {status === "idle" ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <Card key={title}>
              <CardHeader>
                <Icon className="size-5 text-primary" />
                <CardTitle className="mt-2 text-sm">{title}</CardTitle>
                <CardDescription>{body}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Phase 2 の暫定結果表示（グループ化・キャッシュ・削除は Phase 3）。
function ScanResults({
  records,
  ok,
  failed,
  elapsedMs,
}: {
  records: HashResponse[];
  ok: number;
  failed: number;
  elapsedMs: number;
}) {
  const sample = records.slice(0, 24);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">処理結果</span>
        <Badge variant="secondary">
          成功 <span className="num ml-1">{ok}</span>
        </Badge>
        {failed > 0 ? (
          <Badge variant="secondary" className="text-warning">
            失敗 <span className="num ml-1">{failed}</span>
          </Badge>
        ) : null}
        <span className="text-muted-foreground">
          所要 <span className="num">{elapsedMs}</span> ms
        </span>
        <span className="ml-auto text-muted-foreground">グループ化・削除は Phase 3</span>
      </div>

      <Card>
        <ul className="divide-y divide-border text-sm">
          {sample.map((r) => (
            <li key={r.path} className="flex items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 truncate" title={r.path}>
                {r.path}
              </span>
              {r.error ? (
                <span className="shrink-0 text-warning">失敗</span>
              ) : (
                <>
                  <span className="num shrink-0 text-muted-foreground">
                    {r.width}×{r.height}
                  </span>
                  <span className="num shrink-0 text-primary-text" title={r.phash ?? ""}>
                    {r.phash?.slice(0, 8)}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {records.length > sample.length ? (
        <p className="text-center text-sm text-muted-foreground">
          ほか <span className="num">{records.length - sample.length}</span> 件
        </p>
      ) : null}
    </section>
  );
}
