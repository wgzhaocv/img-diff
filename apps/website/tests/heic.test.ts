import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import type { ConvertOptions } from "schema";
import { applyConvert, applyInfo, type DecodeSource, type Vips } from "@/workers/vips";
import { applyHeicDecode, isAv1Heif, type HeifDecoder, type LibHeif } from "@/workers/heic";

// HEVC の HEIC は wasm-vips が読めないので補助デコーダ（libheif-js）で補う。SPEC §1。
// 夹具は合成画像から作った実ファイル（SPEC §1「固定画像 + 既知 dHash」の第一歩）。
//
// **両端の dHash が一致することは `scripts/check-heic-parity.sh` が確かめる**
// （原生 libvips が要るのでここには置けない）。この試験が守るのは web 側の再現性
// —— libheif を上げたときに画素が変わったら気づけるようにする。

// **`Buffer.buffer` をそのまま使わない** —— node の Buffer は共有プール上の view なので、
// その ArrayBuffer にはファイル以外の中身も入っている（デコーダが読む領域がずれる）。
const heicBytes: ArrayBuffer = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/sample.heic", import.meta.url))),
).buffer;
/** 記録した復号結果（libheif-js 1.23.2）。変わったら「なぜ変わったか」を必ず確かめること。 */
const RGBA_SHA256 = "8a0f18af5fbcc6b8d964dd5af4b3b46aa1fc055dd1c7b8c00e493c3ae244439d";

let vips: Vips;
let source: Extract<DecodeSource, { kind: "rgba" }>;
let decoder: HeifDecoder;

const defaults: ConvertOptions = {
  width: null,
  height: null,
  fit: "cover",
  gravity: "center",
  background: null,
  format: null,
  quality: 80,
  forceReencode: false,
};

/** 出力バイト列を読み直して、実際に何が書かれたかを見る。 */
function inspect(out: Uint8Array): { width: number; height: number; loader: string } {
  const im = vips.Image.newFromBuffer(out) as unknown as {
    width: number;
    height: number;
    getString(name: string): string;
    delete(): void;
  };
  const r = { width: im.width, height: im.height, loader: im.getString("vips-loader") };
  im.delete();
  return r;
}

beforeAll(async () => {
  const mod = (await import("wasm-vips")) as unknown as {
    default: (cfg?: Record<string, unknown>) => Promise<Vips>;
  };
  const v = await mod.default({ dynamicLibraries: ["vips-heif.wasm", "vips-jxl.wasm"] });
  v.concurrency(1);
  vips = v;

  // **本番と同じグルー**を node から読む（wasm はディスク上の実ファイルを指す）。
  const heifMod = (await import("libheif-js/libheif-wasm/libheif.js")) as unknown as {
    default: (opts?: { locateFile?: (f: string) => string }) => Promise<LibHeif> | LibHeif;
  };
  const wasmPath = fileURLToPath(
    new URL("../node_modules/libheif-js/libheif-wasm/libheif.wasm", import.meta.url),
  );
  const libheif = await heifMod.default({ locateFile: () => wasmPath });
  decoder = new libheif.HeifDecoder();
  const decoded = await applyHeicDecode(decoder, heicBytes);
  source = { kind: "rgba", data: decoded.rgba, width: decoded.width, height: decoded.height };
}, 60_000);

describe("HEVC の HEIC（wasm-vips では読めない形式）", () => {
  it("wasm-vips 単体では画素を読めない（この補助デコーダが要る理由そのもの）", () => {
    // 寸法を指定して**実際にデコードさせる**。libvips は遅延評価なので、素通し経路
    // （何も変えない指定）だとヘッダしか読まず、読めないことに気づけない。
    expect(() =>
      applyConvert(
        vips,
        { kind: "encoded", bytes: heicBytes },
        { ...defaults, width: 100, height: 100, format: "png" },
        "heic",
      ),
    ).toThrow();
  });

  it("補助デコーダの結果は再現する（libheif を上げて画素が変わったら落ちる）", () => {
    expect([source.width, source.height]).toEqual([300, 500]);
    expect(createHash("sha256").update(source.data).digest("hex")).toBe(RGBA_SHA256);
  });

  it("解いた画素はそのまま変換に流せる（png / jpg）", () => {
    for (const [format, loader] of [
      ["png", "pngload_buffer"],
      ["jpg", "jpegload_buffer"],
    ] as const) {
      const r = applyConvert(vips, source, { ...defaults, format }, "heic");
      const got = inspect(r.out);
      expect([got.width, got.height], format).toEqual([300, 500]);
      expect(got.loader, format).toBe(loader);
    }
  });

  it("出力形式を指定しないと書けない（読めても書けるようにはならない）", () => {
    // heic は書けない形式。画面は押す前にこれを弾く（`cannotWriteReason`）。
    expect(() => applyConvert(vips, source, { ...defaults, width: 150 }, "heic")).toThrow();
  });

  it("出力形式を指定すれば寸法の指定も効く", () => {
    const r = applyConvert(
      vips,
      source,
      { ...defaults, width: 150, height: 100, format: "png" },
      "heic",
    );
    expect(inspect(r.out).width).toBe(150);
  });

  it("入力一覧の情報（原寸 + サムネ）も取れる", () => {
    const info = applyInfo(vips, source);
    expect([info.width, info.height]).toEqual([300, 500]);
    const th = inspect(info.thumb);
    expect(th.loader).toBe("webpload_buffer");
    expect(th.height).toBe(256); // 長辺 256 へ
  });
});

describe("画像ハンドルの解放（リーク防止）", () => {
  // libheif は wasm のヒープ上に context と handle を持つ。解放を忘れると**永久に居座る**
  // （実測: 4.5KB の夹具を 3000 回、毎回 new + free 無しで 16.3 → 48.6MB。
  //  decoder を使い回して free() すると 0）。wasm のヒープは縮まないので、
  //  数百枚のフォルダで効いてくる。ヒープ量は塊単位でしか増えず試験が鈍いので、
  //  **解放したという事実そのもの**を見る。
  const fakeImage = (onFree: () => void) => ({
    get_width: () => 2,
    get_height: () => 2,
    display: (out: { data: Uint8ClampedArray }, cb: (r: unknown) => void) => {
      out.data.fill(255);
      cb(true);
    },
    free: onFree,
  });

  it("**失敗しても**解放する（ここを忘れると壊れた画像ほど溜まる）", async () => {
    let freed = 0;
    const fakeDecoder = {
      decode: () => [
        { ...fakeImage(() => freed++), display: (_o: unknown, cb: (r: unknown) => void) => cb(0) },
      ],
    };
    await expect(applyHeicDecode(fakeDecoder, new ArrayBuffer(0))).rejects.toThrow();
    expect(freed).toBe(1);
  });

  it("複数画像を含む HEIC でも全部解放する", async () => {
    let freed = 0;
    const fakeDecoder = { decode: () => [fakeImage(() => freed++), fakeImage(() => freed++)] };
    await applyHeicDecode(fakeDecoder, new ArrayBuffer(0));
    expect(freed).toBe(2);
  });
});

describe("中身が AV1 の HEIF は本体（wasm-vips）に回す", () => {
  // 補助デコーダ（libheif-js）は **HEVC しか持たない**。`.heic` でも中身が AV1 なら
  // wasm-vips 側が読めるので、**先に容器を見て**振り分ける。失敗してから拾い直す作りだと、
  // 壊れている・時間切れといった本物の理由まで握り潰してしまう。
  const av1: ArrayBuffer = new Uint8Array(
    readFileSync(fileURLToPath(new URL("./fixtures/av1.heic", import.meta.url))),
  ).buffer;

  it("AV1 入りを見分ける", () => {
    expect(isAv1Heif(av1)).toBe(true);
    expect(isAv1Heif(heicBytes)).toBe(false); // HEVC の HEIC
  });

  it("短すぎる・ftyp が無いバイト列で落ちない", () => {
    expect(isAv1Heif(new ArrayBuffer(0))).toBe(false);
    expect(isAv1Heif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toBe(false);
  });

  it("wasm-vips 側で実際に読める（振り分け先が正しい）", () => {
    const r = applyConvert(
      vips,
      { kind: "encoded", bytes: av1 },
      { ...defaults, format: "png" },
      "heic",
    );
    expect(inspect(r.out).width).toBeGreaterThan(0);
  });
});
