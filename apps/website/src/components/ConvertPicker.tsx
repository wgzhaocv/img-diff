import { useCallback, useEffect, useRef, useState } from "react";
import { Images } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/DropZone";
import { walkImages } from "@/lib/fsaccess";
import { extFromMime } from "@/lib/convertControls";
import { isConvertibleImage, uniquePath } from "@/lib/imagePaths";
import type { ConvertSource } from "@/lib/convert";
import { useConvertStore } from "@/lib/stores/convertStore";

// 画像を受け取る口。**受け取り方は 3 つとも同じ入口に集める**: ドロップ・貼り付け・選択。
//
// フォルダを選ぶボタンは置かない —— 変換したいのは画像であってフォルダではない。
// ただしフォルダごと**ドロップ**すれば中の画像を拾う（`dataTransfer.items` から
// ディレクトリ handle を取る。`dataTransfer.files` はフォルダを中身の無い項目として渡してくる）。
// handle が取れた場合だけ入力ルートが分かるので、出力先の重なり検査（SPEC §5.4）もそこで効く。

export function ConvertPicker() {
  const setSources = useConvertStore((s) => s.setSources);
  const setInputRoot = useConvertStore((s) => s.setInputRoot);
  const [reading, setReading] = useState(false);
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
      setInputRoot(null); // File[] 経路には入力フォルダが無い。
      // 別フォルダの同名が衝突し得る。scan と同じく連番で取りこぼさない。
      const used = new Set<string>();
      setSources(
        imgs.map((f): ConvertSource => {
          const path = uniquePath(f.name, used);
          used.add(path);
          return { path, bytes: () => f.arrayBuffer() };
        }),
      );
    },
    [setSources, setInputRoot],
  );

  /** フォルダの handle から中の画像を集める（構造を保って出力するため入力ルートも覚える）。 */
  const takeDirectory = useCallback(
    async (root: FileSystemDirectoryHandle) => {
      setReading(true);
      try {
        const found = await walkImages(root, (name) => isConvertibleImage(name));
        if (found.length === 0) {
          toast.error("このフォルダに画像が見つかりませんでした");
          return;
        }
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
        setReading(false);
      }
    },
    [setSources, setInputRoot],
  );

  /** ドロップ。フォルダが混ざっていれば handle として扱い、それ以外はファイルとして扱う。 */
  const onDrop = useCallback(
    (data: DataTransfer) => {
      const items = Array.from(data.items);
      // getAsFileSystemHandle は Chromium 系のみ。**同期のうちに呼ぶ**（await を挟むと
      // DataTransferItem が無効化される）。
      const handles = items
        .filter((i) => i.kind === "file")
        .map(
          (i): Promise<FileSystemHandle | null> =>
            (i.getAsFileSystemHandle?.() ?? Promise.resolve(null)).catch(() => null),
        );
      const files = Array.from(data.files);
      void (async () => {
        const resolved = await Promise.all(handles);
        const dir = resolved.find((h) => h?.kind === "directory");
        if (dir) {
          await takeDirectory(dir as FileSystemDirectoryHandle);
          return;
        }
        takeFiles(files);
      })();
    },
    [takeDirectory, takeFiles],
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
        multiple
        accept="image/*"
        hidden
        onChange={(e) => {
          takeFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <DropZone
        icon={<Images className="size-6" />}
        title="画像をドロップ、貼り付け、または選択"
        onDrop={onDrop}
      >
        <Button onClick={() => inputRef.current?.click()} disabled={reading} className="gap-1.5">
          <Images className="size-4" />
          {reading ? "読み込み中…" : "画像を選ぶ"}
        </Button>
      </DropZone>
    </>
  );
}
