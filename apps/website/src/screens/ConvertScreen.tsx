import { useRef, useState } from "react";
import { FolderOpen, Images, Replace } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropZone } from "@/components/DropZone";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ConvertOptions } from "@/components/ConvertOptions";
import { formatBytes } from "@/lib/format";
import { toast } from "sonner";
import {
  isSameDirectory,
  pickDirectory,
  pickSaveFile,
  supportsFileSystemAccess,
  walkImages,
} from "@/lib/fsaccess";
import { downloadZipSink, folderSink, streamingZipSink } from "@/lib/convertSinks";
import { isConvertibleImage, uniquePath } from "@/lib/imagePaths";
import { errText } from "@/lib/format";
import type { ConvertSink, ConvertSource } from "@/lib/convert";
import { useConvertStore, type Destination } from "@/lib/stores/convertStore";

// 変換画面（SPEC §5.4）。入力フォルダには一切書かず、出力は「別に選んだフォルダ」か zip。
// 画面の組み立ては ScanScreen と同型（idle / converting / done の条件レンダリング + 線形バー）。

/** zip 出力のファイル名。 */
const ZIP_NAME = "imgdiff-converted.zip";

const DESTINATIONS: { value: Destination; label: string }[] = [
  { value: "folder", label: "フォルダへ保存" },
  { value: "zip", label: "zip でダウンロード" },
];

export function ConvertScreen() {
  const {
    sources,
    form,
    status,
    progress,
    items,
    stats,
    setForm,
    setSources,
    inputRoot,
    setInputRoot,
    run,
    cancel,
    validate,
  } = useConvertStore();
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const converting = status === "converting";
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  async function pickFolder(): Promise<void> {
    setPicking(true);
    try {
      const root = await pickDirectory("read");
      if (!root) return;
      const found = await walkImages(root, (name) => isConvertibleImage(name));
      setInputRoot(root);
      setSources(
        found.map(
          (f): ConvertSource => ({
            path: f.path,
            bytes: async () => (await f.handle.getFile()).arrayBuffer(),
          }),
        ),
      );
    } finally {
      setPicking(false);
    }
  }

  /**
   * 「変換する」。**picker はここ（click の同期 continuation）で開く** — `showDirectoryPicker` は
   * transient activation を要るので、ストア側で await してからでは手遅れになる。
   * ブラウザが実際に強制する場所で解決し、ストアには解決済みの sink を渡す。
   */
  async function start(): Promise<void> {
    const problem = validate();
    if (problem) {
      toast.error(problem);
      return;
    }
    let sink: ConvertSink;
    if (form.destination === "folder") {
      // キャンセル（AbortError）は null、権限拒否などは投げる（両者を混ぜると誤診する）。
      const root = await pickDirectory("readwrite").catch((e: unknown) => {
        toast.error("出力先フォルダを開けませんでした", { description: errText(e) });
        return null;
      });
      if (!root) return;
      // **入力フォルダへは決して書かない**（SPEC §5.4 / 画面の約束）。同じ場所を選ばれたら断る。
      // これが無いと、上書きを許可した状態で元画像が置き換わる。
      if (inputRoot && (await isSameDirectory(inputRoot, root))) {
        toast.error("出力先が入力フォルダと同じです", {
          description: "元の画像を書き換えないため、別のフォルダを選んでください。",
        });
        return;
      }
      sink = folderSink(root, form.overwrite);
    } else {
      // 保存先を取れるブラウザなら zip をディスクへ流す（峰値メモリが 1 枚分で済む）。
      const pick = await pickSaveFile(ZIP_NAME).catch((e: unknown) => {
        toast.error("保存先を開けませんでした", { description: errText(e) });
        return { kind: "cancelled" } as const;
      });
      if (pick.kind === "cancelled") return; // やめたなら変換もしない
      sink = pick.kind === "stream" ? streamingZipSink(pick.writable) : downloadZipSink(ZIP_NAME); // 非対応ブラウザ（Firefox / Safari）だけメモリ経由
    }
    await run(sink);
  }

  function takeFiles(files: File[]): void {
    const imgs = files.filter((f) => isConvertibleImage(f.name));
    setInputRoot(null); // File[] 経路には入力フォルダが無い。
    // ドロップの loose File は別フォルダの同名が衝突し得る。scan と同じく連番で取りこぼさない。
    const used = new Set<string>();
    setSources(
      imgs.map((f): ConvertSource => {
        const path = uniquePath(f.name, used);
        used.add(path);
        return { path, bytes: () => f.arrayBuffer() };
      }),
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* FS Access が無いブラウザ（や、ファイル単位で選びたいとき）の入口。ScanScreen と同じ作法。 */}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          takeFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <ScreenHeader title="形式を変換">
        寸法と形式をまとめて変換します。元のフォルダには書き込まず、別に選んだフォルダか zip
        に出力します。処理はすべてブラウザ内で完結します。
      </ScreenHeader>

      {sources.length === 0 ? (
        <DropZone
          icon={<Images className="size-6" />}
          title="画像をドラッグ、または選択"
          hint="フォルダは「選ぶ」ボタンで（Chromium 系ブラウザ）。画像ファイルはドラッグ＆ドロップも可。"
          onFiles={takeFiles}
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            {supportsFileSystemAccess() ? (
              <Button onClick={() => void pickFolder()} disabled={picking} className="gap-1.5">
                <FolderOpen className="size-4" />
                フォルダを選ぶ
              </Button>
            ) : null}
            <Button
              variant={supportsFileSystemAccess() ? "outline" : "default"}
              onClick={() => inputRef.current?.click()}
              disabled={picking}
              className="gap-1.5"
            >
              <Images className="size-4" />
              ファイルを選ぶ
            </Button>
          </div>
        </DropZone>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              <span className="num text-foreground">{sources.length}</span> 件を変換します。
            </p>
            <Button variant="ghost" size="sm" onClick={() => setSources([])} disabled={converting}>
              選び直す
            </Button>
          </div>

          <ConvertOptions disabled={converting} />

          <fieldset className="space-y-3" disabled={converting}>
            <legend className="text-sm font-medium">保存先</legend>
            <Tabs
              value={form.destination}
              onValueChange={(v) => setForm({ destination: v as Destination })}
            >
              <TabsList>
                {DESTINATIONS.map((d) => (
                  <TabsTrigger key={d.value} value={d.value}>
                    {d.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {form.destination === "folder" ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  実行すると保存先フォルダを聞きます。元のフォルダ構造を保って書き出し、
                  <strong className="font-medium text-foreground">
                    同名のファイルが既にあれば飛ばします
                  </strong>
                  。
                </p>
                <label className="flex w-fit items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={form.overwrite}
                    onChange={(e) => setForm({ overwrite: e.target.checked })}
                  />
                  既にあるファイルを上書きする
                </label>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                全件を 1 つの zip
                にまとめてダウンロードします。枚数が多いときはフォルダ保存の方が軽いです。
              </p>
            )}
          </fieldset>

          <div className="flex items-center gap-3">
            <Button onClick={() => void start()} disabled={converting} className="gap-1.5">
              <Replace className="size-4" />
              変換する
            </Button>
            {converting ? (
              <Button variant="outline" onClick={cancel}>
                中断
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {converting ? (
        <div className="space-y-2" role="status" aria-live="polite">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">変換中…</span>
            <span className="num">
              {progress.processed} / {progress.total}
            </span>
          </div>
          <Progress value={pct} />
        </div>
      ) : null}

      {status === "done" && stats ? (
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
          {stats.failed > 0 ? (
            <ul className="space-y-1 text-sm">
              {items
                .filter((i) => i.status === "failed")
                .slice(0, 20)
                .map((i) => (
                  <li key={i.src} className="text-muted-foreground">
                    <span className="font-mono text-foreground">{i.src}</span> — {i.error}
                  </li>
                ))}
            </ul>
          ) : null}
          {stats.converted > 0 ? (
            <p className="text-sm text-muted-foreground">
              出力 <span className="num text-foreground">{formatBytes(totalBytes(items))}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function totalBytes(items: { bytes: number }[]): number {
  return items.reduce((n, i) => n + i.bytes, 0);
}
