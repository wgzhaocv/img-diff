import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Thumb } from "@/components/Thumb";
import { formatBytes } from "@/lib/format";
import { baseNameOf } from "@/lib/imagePaths";
import { cn } from "@/lib/utils";
import { representativePath, SOURCE_INFO_PAGE, useConvertStore } from "@/lib/stores/convertStore";

// 選んだ画像そのものを見せる（件数だけでは何を選んだのか分からない）。
// セルの作りは DuplicateGroups と同じ: 正方形・object-cover・市松背景・全 path を alt に。
//
// **サムネは表示する分しか作らない。** 1 件ごとに worker でデコードするので、
// 数千枚のフォルダで全件やると変換より先にそこで時間を使ってしまう。

export function ConvertSources() {
  const sources = useConvertStore((s) => s.sources);
  const infoLimit = useConvertStore((s) => s.infoLimit);
  const converting = useConvertStore((s) => s.status === "converting");
  const loadSourceInfo = useConvertStore((s) => s.loadSourceInfo);
  const setSources = useConvertStore((s) => s.setSources);

  // 選び直すたびに先頭 1 ページぶんを取りに行く（寸法欄の原寸プリフィルもこの結果で決まる）。
  useEffect(() => {
    void loadSourceInfo(SOURCE_INFO_PAGE);
  }, [sources, loadSourceInfo]);

  // 取得の完了を待たずに枠を出す（サムネは届いた順に埋まる）。
  const shown = Math.min(sources.length, Math.max(infoLimit, SOURCE_INFO_PAGE));
  const rest = sources.length - shown;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          <span className="num text-foreground">{sources.length}</span> 件を変換します。
        </p>
        <Button variant="ghost" size="sm" onClick={() => setSources([])} disabled={converting}>
          選び直す
        </Button>
      </div>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {sources.slice(0, shown).map((src) => (
          <SourceCell key={src.path} path={src.path} />
        ))}
      </ul>

      {rest > 0 ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">
            ほか <span className="num">{rest}</span> 件
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadSourceInfo(shown + SOURCE_INFO_PAGE)}
          >
            もっと見る
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * 1 枚ぶん。**自分の path の情報だけを購読する**ので、サムネが 1 件届いても
 * 再描画されるのはそのセルだけで済む（網格ごと描き直さない）。
 * 押すとプレビューの対象になる（選択は色だけでなくリングと `aria-pressed` でも示す）。
 */
function SourceCell({ path }: { path: string }) {
  const info = useConvertStore((s) => s.sourceInfo.get(path));
  const selected = useConvertStore((s) => representativePath(s) === path);
  const setPreviewPath = useConvertStore((s) => s.setPreviewPath);
  return (
    <li>
      <figure className="space-y-1">
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`プレビューに使う: ${path}`}
          onClick={() => setPreviewPath(path)}
          className="block w-full rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Thumb
            thumb={info?.thumb}
            alt={path}
            className={cn("aspect-square", selected && "ring-2 ring-primary")}
          />
        </button>
        <figcaption className="truncate text-xs text-muted-foreground" title={path}>
          {baseNameOf(path)}
        </figcaption>
        {info == null ? null : info.width > 0 ? (
          <div className="num text-xs text-muted-foreground">
            {info.width}×{info.height} · {formatBytes(info.bytes)}
          </div>
        ) : (
          // デコードできない形式（web の wasm-vips は HEVC の HEIC を読めない）。
          // 空の枠だけ出して黙っていると「まだ読み込み中」に見えるので、状態を文字で言う。
          <div className="text-xs text-warning">読み込めません</div>
        )}
      </figure>
    </li>
  );
}
