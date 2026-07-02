import { useEffect, useState } from "react";

/// Blob/File から object URL を作り、差し替え・アンマウントで確実に解放する（leak 防止）。
/// blob が null の間は null を返す。compare のプレビュー/スライダ表示で共有する。
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return url;
}
