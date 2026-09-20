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
 * client-zip は `ReadableStream` を返せるので、1 件ずつ流し込めば**峰値メモリは同時実行数ぶん**で済む
 * （全件ではない）。
 * 全件を配列に溜めてから `.blob()` すると、実測で 300 枚 × 1MB が +1245MB（流すと +94MB）、
 * 600 枚 × 2MB では +4.6GB まで膨らむ。しかも流した方が 17% 速い。
 */
export function streamingZipSink(writable: FileSystemWritableFileStream): ConvertSink {
  // **各 put() は「自分の 1 件が client-zip に引き取られる」まで待つ。**
  // これで変換側（runConvert の有界並列）へ背圧が伝わり、メモリ上界は同時実行数ぶんに収まる。
  // 単一スロットにすると、並列に呼ばれた put が互いを上書きして**件を落とす**（runConvert は
  // 常に N 本の runner から同時に呼ぶので、これは例外ではなく通常経路）。
  const queue: { entry: ZipEntry; taken: () => void }[] = [];
  let wantMore: (() => void) | null = null;
  let closed = false;
  let failure: unknown = null;

  const signal = (): void => {
    wantMore?.();
    wantMore = null;
  };

  async function* entries(): AsyncGenerator<ZipEntry> {
    for (;;) {
      const next = queue.shift();
      if (next) {
        next.taken(); // その put() を解放（＝次の 1 件を作ってよい）
        yield next.entry;
        continue;
      }
      if (closed) return; // 残りを出し切ってから終わる
      await new Promise<void>((r) => (wantMore = r));
    }
  }

  /** 書き込み先が死んだら、待っている put() を全部起こして理由を伝える。 */
  const drainWaiters = (): void => {
    for (const w of queue.splice(0)) w.taken();
  };

  // **`pipeTo` は writable をロックする。** その状態で `writable.abort()` を直接呼んでも拒否され、
  // 生成器だけ閉じて pipe が正常終了してしまう＝中断したのに「中身の無い完全な zip」が
  // 保存先に書き上がる（実測: 22 バイトの EOCD だけの zip）。中断は pipe 自体に伝える。
  const ac = new AbortController();
  const piped = makeZip(entries())
    .pipeTo(writable, { signal: ac.signal })
    .catch((e: unknown) => {
      failure = e;
      drainWaiters();
    });

  return {
    put: async (path, data) => {
      if (failure) throw failure;
      await new Promise<void>((resolve) => {
        queue.push({ entry: { name: path, input: data }, taken: resolve });
        signal();
      });
      if (failure) throw failure;
      return "written";
    },
    finish: async () => {
      closed = true;
      signal();
      await piped;
      if (failure) throw failure;
    },
    abort: async (reason) => {
      // pipe ごと中断する。既定で書き込み先も abort されるので、中央ディレクトリは書かれず
      // 保存先に半端な（あるいは「空だが完全な」）zip が残らない。
      ac.abort(reason);
      closed = true;
      drainWaiters();
      signal();
      await piped.catch(() => undefined);
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
    // メモリに溜めているだけなので、捨てるだけでよい。
    abort: () => {
      entries.length = 0;
      return Promise.resolve();
    },
  };
}
