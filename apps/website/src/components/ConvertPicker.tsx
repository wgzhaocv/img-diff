import { useRef, useState } from "react";
import { FolderOpen, Images } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/DropZone";
import { pickDirectory, supportsFileSystemAccess, walkImages } from "@/lib/fsaccess";
import { isConvertibleImage, uniquePath } from "@/lib/imagePaths";
import type { ConvertSource } from "@/lib/convert";
import { useConvertStore } from "@/lib/stores/convertStore";

// 入力を受け取る口（フォルダ選択 / ファイル選択 / ドラッグ）。画像が 1 枚も無いときだけ出る。
// ストアからは**操作だけ**を取る（zustand の action は同一参照なので、これ自体は再描画の原因にならない）。

export function ConvertPicker() {
  const setSources = useConvertStore((s) => s.setSources);
  const setInputRoot = useConvertStore((s) => s.setInputRoot);
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
    <>
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
    </>
  );
}
