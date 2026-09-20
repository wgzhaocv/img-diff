// convert の出力先 2 種（SPEC §5.4）。本体（convert.ts）はどちらかを知らずに動く。
//
// **入力フォルダには一切書かない。** 出力は利用者が別に選んだフォルダか zip。
// そのぶん入力側に readwrite 権限（削除と同格）を要求せずに済む。

import { makeZip } from "client-zip";
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

/** zip に積む 1 件（client-zip が受け取る形）。 */
type ZipEntry = { name: string; input: Uint8Array<ArrayBuffer> };

/**
 * zip をディスクへ**流しながら**書く。`showSaveFilePicker` で保存先を先に取ってあること。
 *
 * client-zip は `ReadableStream` を返せるので、1 件ずつ流し込めば**峰値メモリは 1 枚分**で済む。
 * 全件を配列に溜めてから `.blob()` すると、実測で 300 枚 × 1MB が +1245MB（流すと +94MB）、
 * 600 枚 × 2MB では +4.6GB まで膨らむ。しかも流した方が 17% 速い。
 */
export function streamingZipSink(writable: FileSystemWritableFileStream): ConvertSink {
  // put() が積み、ジェネレータが引く。client-zip が引くぶんだけ進むので背圧も効く。
  const queue: ZipEntry[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    wake?.();
    wake = null;
  };

  async function* entries(): AsyncGenerator<ZipEntry> {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) return;
      await new Promise<void>((r) => (wake = r));
    }
  }

  const piped = makeZip(entries()).pipeTo(writable);

  return {
    put: (path, data) => {
      queue.push({ name: path, input: data });
      nudge();
      return Promise.resolve("written");
    },
    finish: async () => {
      done = true;
      nudge();
      await piped;
    },
  };
}

/**
 * zip をメモリで組み立ててダウンロードさせる（`showSaveFilePicker` が無いブラウザ用の退路）。
 * **全件をメモリに抱える**ので、枚数が多いときはフォルダ出力を勧める。
 */
export function downloadZipSink(fileName: string): ConvertSink {
  const entries: ZipEntry[] = [];
  return {
    put: (path, data) => {
      entries.push({ name: path, input: data });
      return Promise.resolve("written");
    },
    finish: async () => {
      if (entries.length === 0) return;
      const blob = await new Response(makeZip(entries)).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  };
}
