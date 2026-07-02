import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// 原画から objectURL を作ってサムネ表示（透過 PNG は市松背景）。マウント中だけ URL を保持し解放する。
export function Thumb({
  file,
  alt,
  className,
}: {
  file: File | undefined;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [file]);

  return (
    <div className={cn("checker overflow-hidden rounded-md border border-border", className)}>
      {url ? <img src={url} alt={alt} loading="lazy" className="size-full object-cover" /> : null}
    </div>
  );
}
