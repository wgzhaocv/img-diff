// convert の**実際の画素操作**（SPEC §5.4）を、本物の wasm-vips で回して検証する。
// `applyConvert` は vips 実体を引数で受けるので、ブラウザ用の `getVips()`（/vips/*.js を URL で読む）
// を経由せず、node 版の wasm-vips を直接渡して同じコードを走らせられる。
//
// ここが守るのは「計画（convertPlan）が正しく vips 操作へ写っているか」。
// 計画そのものの算術は convertPlan.test.ts 側。

import { beforeAll, describe, expect, it } from "vite-plus/test";
import type { ConvertOptions } from "schema";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyConvert, applyInfo, type DecodeSource, type Vips } from "@/workers/vips";
import { passesThrough, plannedOutput } from "@/lib/convertPlan";
import { convertOptions } from "./options";

/** 符号化済みバイト列を入力の形にする（HEIC 以外はこちら）。 */
const enc = (bytes: ArrayBuffer): DecodeSource => ({ kind: "encoded", bytes });

let vips: Vips;
/** `makePng` は node 版の API（`newFromMemory`）を使うので、同じ実体を別の型で持つ。 */
let vipsNode: VipsNode;
/** 1024x1024 相当を避けて軽く回すための合成画像（左半分が濃い色・右半分が暗い色）。 */
let squarePng: ArrayBuffer;
let widePng: ArrayBuffer;

type VipsNode = {
  Image: {
    newFromBuffer(data: Uint8Array): { writeToBuffer(s: string): Uint8Array; delete(): void };
    newFromMemory(
      data: Uint8Array,
      w: number,
      h: number,
      bands: number,
      fmt: string,
    ): { writeToBuffer(s: string): Uint8Array; delete(): void };
  };
  concurrency(n: number): void;
};

/** 左半分 (200,100,50) / 右半分 (10,20,30) の RGB 画像を PNG バイト列で作る。 */
function makePng(v: VipsNode, w: number, h: number): ArrayBuffer {
  const buf = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const left = x < w / 2;
      buf[i] = left ? 200 : 10;
      buf[i + 1] = left ? 100 : 20;
      buf[i + 2] = left ? 50 : 30;
    }
  }
  const im = v.Image.newFromMemory(buf, w, h, 3, "uchar");
  const png = im.writeToBuffer(".png");
  im.delete();
  return png.slice().buffer as ArrayBuffer;
}

beforeAll(async () => {
  // node 版のエントリを直接読む（ブラウザ版は /vips/ の URL を前提にしていて node では動かない）。
  const mod = (await import("wasm-vips")) as unknown as {
    default: (cfg?: Record<string, unknown>) => Promise<VipsNode>;
  };
  const v = await mod.default({ dynamicLibraries: ["vips-heif.wasm", "vips-jxl.wasm"] });
  v.concurrency(1);
  vips = v as unknown as Vips;
  vipsNode = v;
  squarePng = makePng(v, 100, 100);
  widePng = makePng(v, 100, 50);
}, 60_000);

// この試験は背景が効く経路（contain の余白）を多く通るので、既定を白にしておく。
const defaults: ConvertOptions = convertOptions({ background: "ffffff" });

/**
 * 出力バイト列を**読み直して**寸法・バンド数・ローダ名を見る。
 * ローダ名は libvips が magic から選んだ物なので、「書けたと主張している形式」ではなく
 * 「実際に何で書かれたか」の証拠になる。
 */
function inspect(out: Uint8Array): {
  width: number;
  height: number;
  bands: number;
  loader: string;
} {
  const v = vips as unknown as {
    Image: {
      newFromBuffer(d: Uint8Array): {
        width: number;
        height: number;
        bands: number;
        getString(name: string): string;
        delete(): void;
      };
    };
  };
  const im = v.Image.newFromBuffer(out);
  const r = {
    width: im.width,
    height: im.height,
    bands: im.bands,
    loader: im.getString("vips-loader"),
  };
  im.delete();
  return r;
}

describe("出力形式", () => {
  // 期待するローダ名（libvips が magic から選ぶ物＝**実際に何で書かれたか**の証拠。
  // 実装の自己申告ではないので、保存器を取り違えたら必ず落ちる）。
  const LOADER: Record<string, string> = {
    jpg: "jpegload_buffer",
    png: "pngload_buffer",
    webp: "webpload_buffer",
    gif: "gifload_buffer",
    tiff: "tiffload_buffer",
    ppm: "ppmload_buffer",
    avif: "heifload_buffer",
    jxl: "jxlload_buffer",
  };

  it("**書けない形式は実際に投げる**（一覧が libvips と食い違っていないか）", () => {
    // 一覧を「自分自身」と突き合わせても意味が無い。本物の wasm-vips に対して、
    // 書けないと言っている形式が本当に書けないことを確かめる。
    for (const format of ["heic", "heif", "svg", "bmp"]) {
      expect(
        () => applyConvert(vips, enc(squarePng), { ...defaults, format }, "png"),
        format,
      ).toThrow();
    }
  });

  it("平均色の背景でも壊れない（二度読みするので sequential にしない経路）", () => {
    // `bg=average` は「縮小後から平均を取る → その色で埋める」＝同じ入力を 2 回読む。
    // sequential で読んでいると libvips が拒否するので、その組み合わせだけ既定で読む。
    const r = applyConvert(
      vips,
      enc(widePng),
      { ...defaults, width: 60, height: 60, fit: "contain", background: "average" },
      "png",
    );
    expect(inspect(r.out).width).toBe(60);
  });

  it("書ける形式をすべて往復できる（jxl / avif を含む）", () => {
    for (const [format, loader] of Object.entries(LOADER)) {
      const r = applyConvert(vips, enc(squarePng), { ...defaults, format }, "png");
      expect(r.out.byteLength, format).toBeGreaterThan(0);
      const got = inspect(r.out);
      expect(got.width, format).toBe(100);
      expect(got.loader, format).toBe(loader);
    }
  });

  it("別名は正規化される（jpeg → jpg / tif → tiff）", () => {
    const of = (format: string): string =>
      inspect(applyConvert(vips, enc(squarePng), { ...defaults, format }, "png").out).loader;
    expect(of("jpeg")).toBe("jpegload_buffer");
    expect(of("tif")).toBe("tiffload_buffer");
  });

  it("heic は書けない（SPEC §5.4 でやらないと決めた形式）", () => {
    expect(() =>
      applyConvert(vips, enc(squarePng), { ...defaults, format: "heic" }, "png"),
    ).toThrow();
  });

  it("gif / ppm は Q を付けずに書ける（付けると libvips が失敗する）", () => {
    for (const format of ["gif", "ppm"]) {
      expect(() =>
        applyConvert(vips, enc(squarePng), { ...defaults, format, quality: 50 }, "png"),
      ).not.toThrow();
    }
  });
});

describe("fit ごとの実寸法", () => {
  it("cover は目標ちょうど", () => {
    const r = applyConvert(vips, enc(widePng), { ...defaults, width: 40, height: 30 }, "png");
    expect(inspect(r.out)).toMatchObject({ width: 40, height: 30 });
  });

  it("contain も目標ちょうど（余白は背景で埋まる）", () => {
    const r = applyConvert(
      vips,
      enc(widePng),
      { ...defaults, width: 40, height: 30, fit: "contain" },
      "png",
    );
    expect(inspect(r.out)).toMatchObject({ width: 40, height: 30 });
  });

  it("fill は非等比に引き伸ばす", () => {
    const r = applyConvert(
      vips,
      enc(widePng),
      { ...defaults, width: 50, height: 40, fit: "fill" },
      "png",
    );
    expect(inspect(r.out)).toMatchObject({ width: 50, height: 40 });
  });

  it("拡大はしない（目標が大きくても元の寸法のまま）", () => {
    const r = applyConvert(vips, enc(widePng), { ...defaults, width: 500, height: 500 }, "png");
    expect(inspect(r.out)).toMatchObject({ width: 100, height: 50 });
  });
});

describe("contain の背景", () => {
  it("transparent は alpha を足して角が透明になる", () => {
    const r = applyConvert(
      vips,
      enc(widePng),
      { ...defaults, width: 40, height: 30, fit: "contain", background: "transparent" },
      "png",
    );
    expect(inspect(r.out).bands).toBe(4);
  });

  it("hex 背景では alpha を増やさない（3 バンドのまま）", () => {
    const r = applyConvert(
      vips,
      enc(widePng),
      { ...defaults, width: 40, height: 30, fit: "contain", background: "ff0000" },
      "png",
    );
    expect(inspect(r.out).bands).toBe(3);
  });

  it("average 背景でも破綻しない", () => {
    const r = applyConvert(
      vips,
      enc(widePng),
      { ...defaults, width: 40, height: 30, fit: "contain", background: "average" },
      "png",
    );
    expect(inspect(r.out)).toMatchObject({ width: 40, height: 30, bands: 3 });
  });
});

describe("グレースケール（bands が 3/4 でない画像）", () => {
  // libvips の embed は背景ベクタの本数が画像の bands と一致しないと例外を投げる。
  // 1band / 2band を取りこぼすと、グレースケール PNG を入れた瞬間に落ちる。
  let gray1: ArrayBuffer;
  let gray2: ArrayBuffer;

  beforeAll(() => {
    const v = vips as unknown as {
      Image: {
        newFromMemory(
          d: Uint8Array,
          w: number,
          h: number,
          b: number,
          f: string,
        ): { writeToBuffer(s: string): Uint8Array; bandjoin(n: number): unknown; delete(): void };
      };
    };
    const w = 100;
    const h = 50;
    const g = new Uint8Array(w * h).fill(120);
    const im1 = v.Image.newFromMemory(g, w, h, 1, "uchar");
    gray1 = im1.writeToBuffer(".png").slice().buffer as ArrayBuffer;
    im1.delete();
    const ga = new Uint8Array(w * h * 2);
    for (let i = 0; i < w * h; i++) {
      ga[i * 2] = 120;
      ga[i * 2 + 1] = 255;
    }
    const im2 = v.Image.newFromMemory(ga, w, h, 2, "uchar");
    gray2 = im2.writeToBuffer(".png").slice().buffer as ArrayBuffer;
    im2.delete();
  });

  it("1band を contain + hex 背景で変換できる", () => {
    const r = applyConvert(
      vips,
      enc(gray1),
      { ...defaults, width: 40, height: 40, fit: "contain", background: "ff0000" },
      "png",
    );
    expect(inspect(r.out)).toMatchObject({ width: 40, height: 40 });
  });

  it("1band を contain + transparent で変換できる", () => {
    const r = applyConvert(
      vips,
      enc(gray1),
      { ...defaults, width: 40, height: 40, fit: "contain", background: "transparent" },
      "png",
    );
    expect(inspect(r.out)).toMatchObject({ width: 40, height: 40 });
  });

  it("1band を contain + average で変換できる", () => {
    const r = applyConvert(
      vips,
      enc(gray1),
      { ...defaults, width: 40, height: 40, fit: "contain", background: "average" },
      "png",
    );
    expect(inspect(r.out)).toMatchObject({ width: 40, height: 40 });
  });

  it("2band（グレー + アルファ）も変換できる", () => {
    const r = applyConvert(
      vips,
      enc(gray2),
      { ...defaults, width: 40, height: 40, fit: "contain", background: "ff0000" },
      "png",
    );
    expect(inspect(r.out)).toMatchObject({ width: 40, height: 40 });
  });
});

describe("gravity", () => {
  // 100x50 を 40x30 に cover → 中間 60x30 から横に 20px 余る。
  // 左半分が (200,100,50)・右半分が (10,20,30) なので、west は明るく east は暗い。
  const meanOf = (out: Uint8Array): number => {
    const v = vips as unknown as {
      Image: { newFromBuffer(d: Uint8Array): { avg(): number; delete(): void } };
    };
    const im = v.Image.newFromBuffer(out);
    const a = im.avg();
    im.delete();
    return a;
  };

  it("west は左側（明るい方）、east は右側（暗い方）を切り出す", () => {
    const west = applyConvert(
      vips,
      enc(widePng),
      { ...defaults, width: 40, height: 30, gravity: "west" },
      "png",
    );
    const east = applyConvert(
      vips,
      enc(widePng),
      { ...defaults, width: 40, height: 30, gravity: "east" },
      "png",
    );
    expect(meanOf(west.out)).toBeGreaterThan(meanOf(east.out));
  });
});

describe("入力一覧の情報取得（applyInfo）", () => {
  it("原寸とサムネを返し、**全分解能の複製を作らない**", () => {
    const r = applyInfo(vips, enc(widePng)); // 100×50
    expect(r.width).toBe(100);
    expect(r.height).toBe(50);
    // 長辺 256 に収める＝拡大はしないので原寸のまま。
    const th = inspect(r.thumb);
    expect(th.loader).toBe("webpload_buffer");
    expect(th.width).toBe(100);
  });

  it("大きい画像は長辺 256 まで縮む（縦横比は保つ）", () => {
    const big = makePng(vipsNode, 1024, 512);
    const r = applyInfo(vips, enc(big));
    expect(r.width).toBe(1024);
    expect(r.height).toBe(512);
    const th = inspect(r.thumb);
    expect(th.width).toBe(256);
  });

  it("デコードできない入力は握り潰さず投げる（画面が「読み込めません」と言えるように）", () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    expect(() => applyInfo(vips, enc(garbage))).toThrow();
  });
});

/** 1600×1200・orientation=6 の実ファイル（autorot 後は 1200×1600）。 */
const rotated: ArrayBuffer = new Uint8Array(
  readFileSync(fileURLToPath(new URL("../../../tests/fixtures/rotated.jpg", import.meta.url))),
).buffer;

describe("EXIF の向きが付いた実ファイル", () => {
  // **合成 PNG だけで試験していると気づけない穴がある。** 実際、読み込みを
  // `[access=sequential]` にしたとき、向きの付いた jpeg が**すべて**落ちるようになったのに
  // 合成夹具は素通しした（`autorot` が非単調に読むため。小さい画像だと行キャッシュに収まって
  // 再現もしない）。1600×1200・orientation=6 の実ファイルで、その経路を踏み続ける。
  it("向きを適用して縦横が入れ替わる", () => {
    const r = applyConvert(vips, enc(rotated), { ...defaults, format: "png" }, "jpg");
    const got = inspect(r.out);
    // 1600×1200 を 90 度回すので 1200×1600。
    expect([got.width, got.height]).toEqual([1200, 1600]);
  });

  it("書ける形式すべてで落ちない", () => {
    // avif は 1600×1200 だと秒単位かかるので外す（別の試験が符号化そのものを見ている）。
    for (const format of ["jpg", "png", "webp", "tiff"]) {
      expect(
        () => applyConvert(vips, enc(rotated), { ...defaults, format }, "jpg"),
        format,
      ).not.toThrow();
    }
  });

  it("平均色の背景（二度読みする経路）でも落ちない", () => {
    expect(() =>
      applyConvert(
        vips,
        enc(rotated),
        { ...defaults, width: 400, height: 400, fit: "contain", background: "average" },
        "jpg",
      ),
    ).not.toThrow();
  });

  it("入力一覧の情報も取れる", () => {
    const info = applyInfo(vips, enc(rotated));
    expect([info.width, info.height]).toEqual([1200, 1600]);
  });
});

// --- 主線程の「素通しするか」の予測 vs ワーカーの実際 -----------------------------------------
//
// **この 2 つが食い違うと必ずどちらかが壊れる。** 予測が甘ければ変換すべき物を素通しさせ、
// 辛ければ「何も変えない」指定のために全部読んで全部デコードする（実際そうなっていた ——
// `prefillDimensions` が原寸を寸法欄に入れるので、`isPassThrough` が永久に false を返していた）。
//
// 予測側は画面がやるのと同じ順に通す: `applyInfo` の原寸 → `plannedOutput` → `passesThrough`。

describe("素通しの予測が、実際の変換と一致する", () => {
  /**
   * 原寸から `passesThrough` の予測を出し、`applyConvert` の実際と突き合わせる。
   * `info` は呼び出し側が持つ —— `applyInfo` は**ヘッダ読みではなく本物のデコード + 符号化**
   * （`thumbnailBuffer`）なので、組み合わせごとに取り直すと試験だけで数百 ms 増える。
   */
  function agree(
    bytes: ArrayBuffer,
    info: { width: number; height: number },
    options: ConvertOptions,
    srcFormat: string,
    label: string,
  ) {
    const planned = plannedOutput(options, info);
    const predicted = passesThrough(options, srcFormat, planned);
    const actual = applyConvert(vips, enc(bytes), options, srcFormat);
    expect(predicted, `${label}: 予測と実際`).toBe(actual.passedThrough === true);
    if (predicted) {
      // 素通しと言った以上、**出力は入力とバイト一致**でなければならない。
      const same = Buffer.compare(Buffer.from(actual.out), Buffer.from(new Uint8Array(bytes)));
      expect(same, `${label}: バイト一致`).toBe(0);
    }
  }

  it("寸法 × 形式 × 再符号化の組み合わせで食い違わない", () => {
    // `rotated.jpg` を必ず入れる —— **ヘッダの寸法と autorot 後の寸法が違う唯一の入力**なので、
    // `applyInfo` と `applyConvert` の寸法がずれた瞬間にここが落ちる。
    const inputs: [string, ArrayBuffer, string][] = [
      ["squarePng", squarePng, "png"],
      ["widePng", widePng, "png"],
      ["rotated.jpg", rotated, "jpg"],
    ];
    for (const [name, bytes, srcFormat] of inputs) {
      const info = applyInfo(vips, enc(bytes));
      const dims: [number | null, number | null][] = [
        [null, null],
        [info.width, info.height],
        [info.width - 1, info.height - 1],
        [info.width + 1, info.height + 1],
      ];
      for (const [width, height] of dims) {
        for (const format of [null, srcFormat, "png"]) {
          for (const forceReencode of [false, true]) {
            agree(
              bytes,
              info,
              { ...defaults, width, height, format, forceReencode },
              srcFormat,
              `${name} ${width}x${height} → ${format ?? "同じ"}${forceReencode ? " (再符号化)" : ""}`,
            );
          }
        }
      }
    }
  });

  it("原寸を寸法欄に入れただけでは変換にならない（この巡で直した所）", () => {
    const info = applyInfo(vips, enc(squarePng));
    const options: ConvertOptions = {
      ...defaults,
      width: info.width,
      height: info.height,
      format: null,
    };
    // **原寸を渡さないとここで取りこぼす**（寸法欄が空でないので）。
    expect(passesThrough(options, "png")).toBe(false);
    // 原寸から計画を作れば、効かない寸法指定だと分かる。
    expect(passesThrough(options, "png", plannedOutput(options, info))).toBe(true);
    expect(applyConvert(vips, enc(squarePng), options, "png").passedThrough).toBe(true);
  });
});
