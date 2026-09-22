import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getThumb } from "@/lib/db";
import { useInView } from "@/lib/useInView";
import { useObjectUrl } from "@/lib/useObjectUrl";

// サムネ表示（透過 PNG は市松背景）。優先度: 渡された thumb Blob（File[] 経路）→ IDB の thumbs
// （FS Access 経路・権限ゼロでも表示可）→ 原 File（フォールバック）。マウント中だけ URL を保持し解放。
//
// **画面に入るまで読まない**（`useInView`）。重複一覧は全メンバを描くので、
// マウントと同時に読むと数千件の IDB 問い合わせが一斉に出る（FS Access 経路は
// `thumbByPath` を持たないので、1 枚 1 問い合わせになる）。
/**
 * 透過画像を置く枠（市松背景 + 罫線 + 角丸）。UI.md §6 の「サムネ網格」の見た目そのもの。
 * `Thumb` を使わない場所（変換プレビューの 2 枚並べ等）でも**同じ枠**にするため公開する。
 */
export const IMAGE_FRAME = "checker overflow-hidden rounded-md border border-border";

export function Thumb({
  file,
  thumb,
  rootId,
  path,
  alt,
  className,
}: {
  file?: File;
  thumb?: Blob;
  rootId?: string;
  path?: string;
  alt: string;
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [blob, setBlob] = useState<Blob | null>(null);
  // URL の作成と解放は `useObjectUrl` に任せる（他の 3 箇所と同じ道を通す）。
  const url = useObjectUrl(blob);

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;

    async function pickBlob(): Promise<Blob | undefined> {
      if (thumb) return thumb;
      if (rootId && path) {
        const cached = await getThumb(rootId, path);
        if (cached) return cached;
      }
      return file;
    }

    void pickBlob().then((picked) => {
      if (!cancelled) setBlob(picked ?? null);
    });

    return () => {
      cancelled = true;
    };
  }, [file, thumb, rootId, path, inView]);

  return (
    <div ref={ref} className={cn(IMAGE_FRAME, className)}>
      {url ? (
        <img src={url} alt={alt} loading="lazy" className="size-full object-cover" />
      ) : (
        // **待っている枠は黙らせない**（UI.md §6）。空の市松だけだと、デコード待ちなのか
        // 何も無いのかが見分けられず、固まったように見える。
        <Skeleton className="size-full rounded-none" />
      )}
    </div>
  );
}
