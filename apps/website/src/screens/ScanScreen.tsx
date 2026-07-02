import { useEffect, useRef, useState } from "react";
import { FolderOpen, Layers, Loader2, ScanLine, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropZone } from "@/components/DropZone";
import { ScreenHeader } from "@/components/ScreenHeader";
import { DuplicateGroups } from "@/components/DuplicateGroups";
import { STRICTNESS_LABEL, STRICTNESS_ORDER, type Strictness } from "@/lib/core";
import { pickDirectory, supportsFileSystemAccess } from "@/lib/fsaccess";
import { useScanStore } from "@/lib/stores/scanStore";
import type { ScanProgress } from "@/lib/scan";

const PHASE_LABEL: Record<ScanProgress["phase"], string> = {
  enumerating: "ファイルを列挙中…",
  hash: "デコード + ハッシュ中…",
  pixel: "ピクセル照合中…",
};

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

export function ScanScreen() {
  const {
    status,
    progress,
    result,
    elapsedMs,
    strictness,
    threshold,
    setStrictness,
    setThreshold,
    runFiles,
    runFolder,
  } = useScanStore();
  const [thresholdInput, setThresholdInput] = useState(threshold);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // フォルダ選択にする（webkitdirectory は JSX 型に無いので属性で付与）。
  useEffect(() => {
    inputRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  // しきい値は連打で O(N²) の perceptual クラスタを毎回走らせないようデバウンスしてストアへ確定（切替は即時）。
  useEffect(() => {
    const t = setTimeout(() => setThreshold(thresholdInput), 250);
    return () => clearTimeout(t);
  }, [thresholdInput, setThreshold]);

  // 「フォルダを選ぶ」: Chromium は FS Access（永続ハンドル + IndexedDB キャッシュ）。他は input フォールバック。
  async function handlePick(): Promise<void> {
    if (!supportsFileSystemAccess()) {
      inputRef.current?.click();
      return;
    }
    const handle = await pickDirectory(); // ユーザー操作内で呼ぶ（transient activation）。
    if (handle) void runFolder(handle);
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = ""; // 同じフォルダを再選択できるように。
    if (files.length > 0) void runFiles(files);
  }

  const scanning = status === "scanning";
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
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
        hint="フォルダは「選ぶ」ボタンで（Chromium 系ブラウザ）。画像ファイルはドラッグ＆ドロップも可。"
        onFiles={(files) => void runFiles(files)}
      >
        <Button onClick={() => void handlePick()} disabled={scanning} className="gap-1.5">
          {scanning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FolderOpen className="size-4" />
          )}
          {scanning ? "処理中…" : "フォルダを選ぶ"}
        </Button>
      </DropZone>

      {scanning ? (
        <div className="mx-auto max-w-2xl space-y-2" role="status" aria-live="polite">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{PHASE_LABEL[progress.phase]}</span>
            <span className="num">
              {progress.processed} / {progress.total}
            </span>
          </div>
          <Progress value={pct} />
        </div>
      ) : null}

      {status === "done" && result ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={strictness} onValueChange={(v) => setStrictness(v as Strictness)}>
              <TabsList>
                {STRICTNESS_ORDER.map((s) => (
                  <TabsTrigger key={s} value={s}>
                    {STRICTNESS_LABEL[s]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {strictness === "perceptual" ? (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                しきい値
                <input
                  type="number"
                  min={0}
                  max={64}
                  value={thresholdInput}
                  onChange={(e) =>
                    setThresholdInput(Math.min(64, Math.max(0, Number(e.currentTarget.value) || 0)))
                  }
                  className="num w-16 rounded-md border border-input bg-card px-2 py-1 text-foreground"
                />
              </label>
            ) : null}
            <span className="ml-auto text-sm text-muted-foreground">
              {result.skipped.length > 0 ? (
                <>
                  スキップ <span className="num text-warning">{result.skipped.length}</span> ·{" "}
                </>
              ) : null}
              所要 <span className="num">{elapsedMs}</span> ms · 削除は Phase 3b
            </span>
          </div>

          <DuplicateGroups />
        </div>
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
