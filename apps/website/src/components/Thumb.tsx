import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { getThumb } from "@/lib/db";

// サムネ表示（透過 PNG は市松背景）。優先度: 渡された thumb Blob（File[] 経路）→ IDB の thumbs
// （FS Access 経路・権限ゼロでも表示可）→ 原 File（フォールバック）。マウント中だけ URL を保持し解放。
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
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    async function pickBlob(): Promise<Blob | undefined> {
      if (thumb) return thumb;
      if (rootId && path) {
        const cached = await getThumb(rootId, path);
        if (cached) return cached;
      }
      return file;
    }

    void pickBlob().then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [file, thumb, rootId, path]);

  return (
    <div className={cn("checker overflow-hidden rounded-md border border-border", className)}>
      {url ? <img src={url} alt={alt} loading="lazy" className="size-full object-cover" /> : null}
    </div>
  );
}
