import { useCallback, useEffect, useRef } from "react";
import { Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/DropZone";
import { extFromMime } from "@/lib/convertControls";
import { isConvertibleImage } from "@/lib/imagePaths";
import { useConvertStore } from "@/lib/stores/convertStore";

// 画像を受け取る口。**受け取り方は 3 つとも同じ入口に集める**: ドロップ・貼り付け・選択。
//
// **扱うのは 1 枚だけ**なので、2 枚以上とフォルダは**受け取らずに断る**。
// 「最初の 1 枚を使う」にはしない —— 40 枚渡して 1 枚だけ変換されるのは、
// 黙って選ばれた 1 枚が何なのか分からないままになる。

export function ConvertPicker() {
  const setSource = useConvertStore((s) => s.setSource);
  const inputRef = useRef<HTMLInputElement>(null);

  const takeFiles = useCallback(
    (files: File[]) => {
      // 貼り付けた画像は名前に拡張子が無いことがある（Safari は名前ごと空）。
      // 捨てる前に MIME から補う —— 「貼り付けたのに何も起きない」が一番分かりにくい。
      const named = files.map((f) => {
        if (isConvertibleImage(f.name)) return f;
        const ext = extFromMime(f.type);
        return ext ? new File([f], `pasted.${ext}`, { type: f.type }) : f;
      });
      const imgs = named.filter((f) => isConvertibleImage(f.name));
      if (imgs.length === 0) {
        if (files.length > 0) toast.error("画像が見つかりませんでした");
        return;
      }
      if (imgs.length > 1) {
        toast.error("1 枚だけ渡してください", {
          description: "この画面は 1 枚ずつ変換します。",
        });
        return;
      }
      const file = imgs[0];
      setSource({ path: file.name, file });
    },
    [setSource],
  );

  /** ドロップ。フォルダが混ざっていたら受け取らない。 */
  const onDrop = useCallback(
    (data: DataTransfer) => {
      const items = Array.from(data.items);
      // getAsFileSystemHandle は Chromium 系のみ。**同期のうちに呼ぶ**（await を挟むと
      // DataTransferItem が無効化される）。フォルダかどうかを見るためだけに使う。
      const handles = items
        .filter((i) => i.kind === "file")
        .map(
          (i): Promise<FileSystemHandle | null> =>
            (i.getAsFileSystemHandle?.() ?? Promise.resolve(null)).catch(() => null),
        );
      const files = Array.from(data.files);
      void (async () => {
        const resolved = await Promise.all(handles);
        if (resolved.some((h) => h?.kind === "directory")) {
          toast.error("フォルダは受け取れません", {
            description: "画像 1 枚をそのまま渡してください。",
          });
          return;
        }
        takeFiles(files);
      })();
    },
    [takeFiles],
  );

  // 貼り付け（スクリーンショットをそのまま変換できるように）。画像を選ぶ前だけ効く。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      takeFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [takeFiles]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          takeFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <DropZone
        icon={<ImageIcon className="size-6" />}
        title="画像 1 枚をドロップ、貼り付け、または選択"
        onDrop={onDrop}
      >
        <Button onClick={() => inputRef.current?.click()} className="gap-1.5">
          <ImageIcon className="size-4" />
          画像を選ぶ
        </Button>
      </DropZone>
    </>
  );
}
