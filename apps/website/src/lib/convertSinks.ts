// convert の出力先 2 種（SPEC §5.4）。本体（convert.ts）はどちらかを知らずに動く。
//
// **入力フォルダには一切書かない。** 出力は利用者が別に選んだフォルダか、zip のダウンロード。
// そのぶん入力側に readwrite 権限（削除と同格）を要求せずに済む。

import { downloadZip } from "client-zip";
import type { ConvertSink } from "@/lib/convert";
import { writeFileAt } from "@/lib/fsaccess";

/**
 * 選んだ出力フォルダへ書く。入力ルートからの相対構造を保ち、
 * **既に在れば skip。`overwrite` を明示したときだけ上書き**（render §5.3 と同じ非破壊規則）。
 */
export function folderSink(root: FileSystemDirectoryHandle, overwrite: boolean): ConvertSink {
  return {
    put: (path, data) => writeFileAt(root, path, data, overwrite),
  };
}

/**
 * zip を組み立ててダウンロードさせる。画像は既に圧縮済みなので client-zip の無圧縮（store）で十分。
 * 全件終わってから 1 つの Blob にするので、`finish` まで内容をメモリに抱える点に注意
 * （大量なら出力フォルダを選ぶ方を勧める）。
 */
export function zipSink(fileName: string): ConvertSink {
  const entries: { name: string; input: Blob }[] = [];
  return {
    put: (path, data) => {
      // zip 内は入力ルートからの相対構造をそのまま使う（同名衝突は起きない）。
      entries.push({ name: path, input: new Blob([data as BlobPart]) });
      return Promise.resolve("written");
    },
    finish: async () => {
      if (entries.length === 0) return;
      const blob = await downloadZip(entries).blob();
      triggerDownload(blob, fileName);
    },
  };
}

/** Blob を名前付きでダウンロードさせる。URL は次のタスクで確実に解放する。 */
function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
