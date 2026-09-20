// 出力先（sink）の検証。zip はブラウザのネイティブ保存ダイアログを経由するので画面からは
// 自動で叩けない —— **node で本物の client-zip を回して、出来た zip を解いて中身を確かめる**。
// こちらの方が「ボタンを押せた」より強い証拠になる。

import { describe, expect, it } from "vite-plus/test";
import { streamingZipSink, downloadZipSink } from "@/lib/convertSinks";

/** `FileSystemWritableFileStream` の代役。書き込まれたバイトを全部ためる。 */
function fakeWritable(): {
  stream: FileSystemWritableFileStream;
  bytes: () => Uint8Array;
  /** close で正常に確定したか（= 保存先にファイルが書き上がったか）。 */
  closed: () => boolean;
  /** abort で畳まれたか。 */
  aborted: () => boolean;
} {
  const chunks: Uint8Array[] = [];
  let closed = false;
  let aborted = false;
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
    close() {
      closed = true;
    },
    abort() {
      aborted = true;
    },
  });
  return {
    stream: stream as unknown as FileSystemWritableFileStream,
    closed: () => closed,
    aborted: () => aborted,
    bytes: () => {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return out;
    },
  };
}

/** zip の中央ディレクトリから「名前 → 非圧縮サイズ」を読む（依存を増やさない最小の読み取り）。 */
function zipEntries(buf: Uint8Array): { name: string; size: number }[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: { name: string; size: number }[] = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (dv.getUint32(i, true) !== 0x02014b50) continue; // central directory header
    const size = dv.getUint32(i + 24, true);
    const nameLen = dv.getUint16(i + 28, true);
    const name = new TextDecoder().decode(buf.subarray(i + 46, i + 46 + nameLen));
    out.push({ name, size });
  }
  return out;
}

const bytesOf = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

describe("streamingZipSink", () => {
  it("1 件ずつ流し込んで、解ける zip になる", async () => {
    const w = fakeWritable();
    const sink = streamingZipSink(w.stream);
    expect(await sink.put("a/one.webp", bytesOf("hello"))).toBe("written");
    expect(await sink.put("b/two.webp", bytesOf("world!!"))).toBe("written");
    await sink.finish?.();

    const entries = zipEntries(w.bytes());
    expect(entries.map((e) => e.name).sort()).toEqual(["a/one.webp", "b/two.webp"]);
    // 相対構造（ディレクトリ）が保たれ、中身のバイト数も合っている。
    expect(entries.find((e) => e.name === "a/one.webp")?.size).toBe(5);
    expect(entries.find((e) => e.name === "b/two.webp")?.size).toBe(7);
  });

  it("1 件も無くても完了する（空 zip）", async () => {
    const w = fakeWritable();
    const sink = streamingZipSink(w.stream);
    await sink.finish?.();
    expect(zipEntries(w.bytes())).toEqual([]);
  });

  it("**並列に put しても 1 件も落とさない**（runConvert は常に N 本から同時に呼ぶ）", async () => {
    const w = fakeWritable();
    const sink = streamingZipSink(w.stream);
    // 単一スロット実装だと、後から来た put が前のを上書きして静かに消える。
    const names = Array.from({ length: 24 }, (_, i) => `f${String(i).padStart(2, "0")}.webp`);
    await Promise.all(names.map((n) => sink.put(n, bytesOf(n))));
    await sink.finish?.();
    expect(
      zipEntries(w.bytes())
        .map((e) => e.name)
        .sort(),
    ).toEqual([...names].sort());
  });

  it("**abort は書き込み先を確定させない**（空でも「完全な zip」を保存しない）", async () => {
    const w = fakeWritable();
    const sink = streamingZipSink(w.stream);
    void sink.put("a.webp", bytesOf("x"));
    await sink.abort?.(new Error("中断"));
    // 「中央ディレクトリが無い」だけでは足りない —— pipeTo が正常に close すると
    // 22 バイトの**空だが完全な** zip が保存先に書き上がってしまう。close されないことを見る。
    expect(w.closed(), "abort したのに close された").toBe(false);
    expect(w.aborted(), "書き込み先が abort されていない").toBe(true);
    expect(zipEntries(w.bytes())).toEqual([]);
  });

  it("finish は書き込み先を正常に確定させる（abort との対比）", async () => {
    const w = fakeWritable();
    const sink = streamingZipSink(w.stream);
    await sink.put("a.webp", bytesOf("x"));
    await sink.finish?.();
    expect(w.closed()).toBe(true);
    expect(w.aborted()).toBe(false);
    expect(zipEntries(w.bytes()).map((e) => e.name)).toEqual(["a.webp"]);
  });

  it("put が終わる前に finish しても取りこぼさない", async () => {
    const w = fakeWritable();
    const sink = streamingZipSink(w.stream);
    // put の Promise を待たずに積んでから締める（画面側の使い方に近い）。
    void sink.put("x.webp", bytesOf("1"));
    void sink.put("y.webp", bytesOf("22"));
    await sink.finish?.();
    expect(
      zipEntries(w.bytes())
        .map((e) => e.name)
        .sort(),
    ).toEqual(["x.webp", "y.webp"]);
  });
});

describe("downloadZipSink（保存ダイアログが無いブラウザの退路）", () => {
  it("put は常に written（skip の概念が無い）", async () => {
    const sink = downloadZipSink("out.zip");
    expect(await sink.put("a.webp", bytesOf("x"))).toBe("written");
  });
});
