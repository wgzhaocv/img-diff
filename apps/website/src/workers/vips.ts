// wasm-vips のロードとデコード（SPEC §1 手順 1〜3）。CLI の decode.rs / pipeline.rs の
// 2 層分離を JS 側でも踏襲し、scan（hash.worker）と compare（Phase 4）で decode→RGBA を共有する。
// 白平坦化・dHash（手順 4〜8）はしない。呼び出し側が core（imgdiff-wasm）で行う。

import type { ConvertOptions } from "schema";
import { decodeHeicToRgba, isAv1Heif, needsHeicDecoder } from "./heic";
import {
  BG_AVERAGE,
  BG_TRANSPARENT,
  backgroundVector,
  effectiveBackground,
  normalizeOutFormat,
  parseHexRgb,
  passesThrough,
  planGeometry,
  saveSpec,
} from "@/lib/convertPlan";

// --- wasm-vips の最小型（/vips/vips-es6.js を動的 import するため自前定義）。 ---
type VipsImage = {
  autorot(): VipsImage;
  colourspace(space: string): VipsImage;
  addalpha(): VipsImage;
  cast(format: string): VipsImage;
  premultiply(): VipsImage;
  unpremultiply(): VipsImage;
  resize(scale: number, options?: { vscale?: number }): VipsImage;
  /** 切り出し（左上原点）。convert の cover で使う。 */
  extractArea(left: number, top: number, width: number, height: number): VipsImage;
  /** 1 バンドだけ取り出す。convert の bg=average で使う。 */
  extractBand(band: number): VipsImage;
  /** 画布へ置いて周囲を埋める。convert の contain で使う。 */
  embed(
    x: number,
    y: number,
    width: number,
    height: number,
    options?: { extend?: string; background?: number[] },
  ): VipsImage;
  /** 全画素の平均値（1 バンドに対して呼ぶ）。 */
  avg(): number;
  /** 全バンドの統計を 1 パスで（行 1..bands が各バンド、列 4 が平均）。 */
  stats(): VipsImage;
  /** 1 画素を読む（統計画像から値を取り出すのに使う）。 */
  getpoint(x: number, y: number): number[];
  writeToMemory(): Uint8Array;
  /** オプションは**必ずこの第 2 引数で**渡す（接尾辞の文字列に下線キーを書くと黙って無視される）。 */
  writeToBuffer(suffix: string, options?: Record<string, unknown>): Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly bands: number;
  delete(): void;
};
/** wasm-vips の実体（テストは node 版を直接読んで渡す）。 */
export type Vips = {
  Image: {
    newFromBuffer(data: Uint8Array, strOptions?: string): VipsImage;
    /** 既に画素になっている入力から作る（補助デコーダを通した HEIC）。 */
    newFromMemory(
      data: Uint8Array,
      width: number,
      height: number,
      bands: number,
      format: string,
    ): VipsImage;
    /** **shrink-on-load** つきの縮小読み込み（jpeg なら間引いて読む）。サムネ専用。 */
    thumbnailBuffer(
      data: Uint8Array,
      width: number,
      options?: { height?: number; size?: string },
    ): VipsImage;
  };
  concurrency(n: number): void;
  Cache: { max(n: number): void; maxMem(n: number): void };
  /** libvips の版（例 "8.18.3"）。`Producer.vips` に入れる。 */
  version(): string;
};
type VipsFactory = (config?: Record<string, unknown>) => Promise<Vips>;

let vipsPromise: Promise<Vips> | null = null;

/// wasm-vips を（ワーカーごとに）一度だけ初期化して使い回す。
export function getVips(): Promise<Vips> {
  if (!vipsPromise) {
    vipsPromise = (async () => {
      // public/vips から実ファイルとして読む（import.meta.url が /vips/ を指し、
      // vips.wasm と pthread ワーカーが正しく解決される。バンドルすると壊れる）。
      // 変数指定にして Vite のバンドル対象から外す（+ TS のモジュール解決エラーも回避）。
      const vipsUrl = "/vips/vips-es6.js";
      const mod = (await import(/* @vite-ignore */ vipsUrl)) as { default: VipsFactory };
      const vips = await mod.default({
        locateFile: (f: string) => `/vips/${f}`,
        // HEIC/AVIF（libheif）・SVG（resvg）・JXL を有効化。
        // **init 時に全部読み込まれる**（emscripten の loadDylibs は遅延しない）。実測で
        // jxl の追加は +2.6ms / +7MB per worker、冷起動のバイト数は 9.27 → 11.34MB。
        // （JXL は convert の入出力で使う。CLI 側は Windows 版が libjxl 非同梱なので web のみ・SPEC §5.4。）
        dynamicLibraries: ["vips-heif.wasm", "vips-resvg.wasm", "vips-jxl.wasm"],
      });
      vips.concurrency(1); // シングルスレッド vips × N ワーカー（DESIGN §4）。
      // 操作キャッシュを切る。scan も convert も**毎回違う画像**を 1 回ずつ処理するので
      // ヒット率は 0 で、wasm ヒープ（固定 1GiB・OS へ返さない）を食うだけ。実測 -53MB/worker。
      vips.Cache.max(0);
      vips.Cache.maxMem(0);
      return vips;
    })();
  }
  return vipsPromise;
}

/**
 * 変換・解析の入力。**バイト列とは限らない** —— HEIC は wasm-vips が読めないので、
 * 補助デコーダ（`heic.ts`）が先に RGBA へ解いたものが来る。
 *
 * この型のおかげで `applyConvert` / `applyInfo` は**同期のまま**でいられる
 * （非同期にすると node からそのまま試験できる seam が壊れる）。
 */
export type DecodeSource =
  | { kind: "encoded"; bytes: ArrayBuffer }
  | { kind: "rgba"; data: Uint8Array; width: number; height: number };

/**
 * 入力を vips 画像にする。**ここだけが「どこから来たか」を知っている。**
 * RGBA 経路は既に画素なので、向き（`autorot`）は補助デコーダが済ませている前提。
 */
function sourceImage(
  vips: Vips,
  src: DecodeSource,
  keep: <T extends VipsImage>(im: T) => T,
): VipsImage {
  if (src.kind === "rgba") {
    // **向きは補助デコーダが適用済み**（libheif が irot/imir を処理する）。メモリ画像に
    // EXIF は無いので、ここで autorot を重ねてはいけない。SPEC §1 手順 2。
    return keep(vips.Image.newFromMemory(src.data, src.width, src.height, 4, "uchar"));
  }
  // **`[access=sequential]` は使わない。** 速くはなる（実測 6000×8000 の jpg 1020→723ms、
  // png 2041→1757ms）が、`autorot()` が非単調に読むので **EXIF の向きが付いた画像がすべて落ちる**
  // （実測 1600×1200: orientation=1 は通るが 3/6/8 は throw。小さい画像だと行キャッシュに
  //  収まって再現しないので、試験で気づけない）。`bg=average` の二度読みも同じ理由で駄目。
  // 手で「この経路は一度しか読まない」と保証し続ける類の最適化は、写真で壊れる形で裏切る。
  const loaded = keep(vips.Image.newFromBuffer(new Uint8Array(src.bytes)));
  return keep(loaded.autorot());
}

export async function toSource(bytes: ArrayBuffer, srcFormat: string): Promise<DecodeSource> {
  // 拡張子が heic/heif でも、**中身が AV1 なら wasm-vips 側が読める**（補助デコーダは HEVC のみ）。
  // 先に容器を見て振り分けるので、補助デコーダが投げた本物の理由は握り潰されない。
  if (!needsHeicDecoder(srcFormat) || isAv1Heif(bytes)) return { kind: "encoded", bytes };
  const { rgba, width, height } = await decodeHeicToRgba(bytes);
  return { kind: "rgba", data: rgba, width, height };
}

export type DecodedImage = {
  rgba: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  /** wantThumb 指定時の ~256px サムネ（webp バイト・原比率）。DESIGN §6。 */
  thumb?: Uint8Array<ArrayBuffer>;
};

/**
 * 中間画像を捨て漏らさないための小道具。wasm-vips のメモリは手動解放なので、
 * 分岐の多い処理では「作ったら即 keep」に統一する（3 箇所が同じ物を書いていた）。
 */
function trashBag(): { keep: <T extends VipsImage>(im: T) => T; dispose: () => void } {
  const trash: VipsImage[] = [];
  return {
    keep: (im) => {
      trash.push(im);
      return im;
    },
    dispose: () => {
      for (const im of trash) im.delete();
    },
  };
}

/** サムネの最大辺（px）。DESIGN §6 の「~256px」。 */
const THUMB_MAX = 256;
/** サムネの符号化。3 箇所で同じ物を書かないため。 */
const THUMB_SUFFIX = ".webp[Q=80]";

/**
 * 既に画素になっている画像から ~256px の webp サムネを作る。
 * 透過は premultiply→resize→unpremultiply でエッジのフリンジを防ぐ。dHash 用の 9x8 とは別物。
 */
function thumbBytes(img: VipsImage): Uint8Array<ArrayBuffer> {
  const { keep, dispose } = trashBag();
  try {
    const scale = Math.min(1, THUMB_MAX / Math.max(img.width, img.height));
    const pm = keep(img.premultiply());
    const rs = keep(pm.resize(scale));
    const um = keep(rs.unpremultiply());
    const uc = um.cast("uchar");
    if (uc !== um) keep(uc);
    return new Uint8Array(uc.writeToBuffer(THUMB_SUFFIX));
  } finally {
    dispose();
  }
}

/// バイト列を sRGB RGBA（straight alpha・uchar・4band・行優先）へデコードする。SPEC §1 手順 1〜3。
/// 手順は CLI `decode.rs::decode_canonical` と同順（autorot→sRGB→3band なら addalpha→cast uchar）。
/// bands が 3/4 以外は CLI 同様エラーにする（誤ハッシュを避け web/CLI 整合を保つ）。
/// wantThumb 指定時は、デコード済み画像から ~256px の webp サムネも生成する（デコードのついで・DESIGN §6）。
export async function decodeCanonical(
  bytes: ArrayBuffer,
  wantThumb: boolean,
  srcFormat: string,
): Promise<DecodedImage> {
  const vips = await getVips();
  const source = await toSource(bytes, srcFormat);

  // **補助デコーダ経由（HEIC）は、もう欲しい形そのもの。** libheif が返すのは
  // sRGB の straight-alpha RGBA（4band・uchar）で、vips を通しても
  // **入出力の sha256 が一致する**ことを確かめてある。往復させると 12MP で
  // 約 146MB（vips ヒープへの複製 + writeToMemory + JS へのコピー）を無駄に使う。
  if (source.kind === "rgba" && !wantThumb) {
    return {
      rgba: source.data as Uint8Array<ArrayBuffer>,
      width: source.width,
      height: source.height,
    };
  }

  const { keep, dispose } = trashBag();
  try {
    const rotated = sourceImage(vips, source, keep);
    const srgb = keep(rotated.colourspace("srgb"));

    let rgbaImg: VipsImage;
    if (srgb.bands === 4) {
      rgbaImg = srgb;
    } else if (srgb.bands === 3) {
      rgbaImg = keep(srgb.addalpha());
    } else {
      throw new Error(`想定外のバンド数 ${srgb.bands}（RGB/RGBA のみ対応）`);
    }
    const casted = rgbaImg.cast("uchar");
    if (casted !== rgbaImg) keep(casted);

    const { width, height } = casted;

    // サムネの生成失敗は**致命でない**（dHash は成功済み）ので握り潰して thumb 無しにする
    // ＝ cosmetic な失敗で画像を dedup から落とさない（表示は原 File / IDB にフォールバック）。
    let thumb: Uint8Array<ArrayBuffer> | undefined;
    if (wantThumb) {
      try {
        thumb = thumbBytes(casted);
      } catch {
        thumb = undefined;
      }
    }

    // 補助デコーダ経由なら画素はもう手元にある（上の早期 return と同じ理由で往復させない）。
    // それ以外は writeToMemory が vips（SharedArrayBuffer）ヒープ上の view を返し得るので、
    // 非 SAB な ArrayBuffer へコピーして返す（delete 後も安全）。
    const rgba =
      source.kind === "rgba"
        ? (source.data as Uint8Array<ArrayBuffer>)
        : new Uint8Array(casted.writeToMemory());
    return { rgba, width, height, thumb };
  } finally {
    dispose(); // wasm-vips のメモリは手動解放（leak 防止）。
  }
}

/** 表示用の情報（原寸とサムネ）。画素の複製は作らない。 */
export type ImageInfo = {
  width: number;
  height: number;
  /** ~256px の webp。非 SAB（Blob 化のため）。 */
  thumb: Uint8Array<ArrayBuffer>;
};

/** [`applyInfo`] のブラウザ向け入口。 */
export async function imageInfo(bytes: ArrayBuffer, srcFormat = ""): Promise<ImageInfo> {
  return applyInfo(await getVips(), await toSource(bytes, srcFormat));
}

/**
 * **見せるためだけ**の情報を取る（原寸 + サムネ）。scan の `decode`/`hash` とは別経路。
 *
 * `decodeCanonical` を流用すると、サムネ 1 枚のために**全分解能の RGBA**（`writeToMemory`）と
 * dHash を作ることになる。実測 4000×3000 の JPEG で 165ms / 45.8MB —— こちらは
 * `thumbnailBuffer` の shrink-on-load で **53ms・その確保なし**（出力 webp は同一バイト数）。
 *
 * **サムネが作れない＝画素をデコードできない**ので、ここは握り潰さず投げる
 * （libvips は遅延評価なので、寸法が読めても実際に描けるとは限らない。
 *   web の wasm-vips は HEVC の HEIC がこれに当たる）。
 */
export function applyInfo(vips: Vips, source: DecodeSource): ImageInfo {
  const { keep, dispose } = trashBag();
  try {
    // 原寸はヘッダだけで分かる（autorot も遅延なので、ここでは画素を触らない）。
    const img = sourceImage(vips, source, keep);
    // **サムネの作り方だけが分かれる。** 符号化済みなら shrink-on-load（1/8 解像度で読む）、
    // 既に画素なら縮小するしかない。
    const thumb =
      source.kind === "encoded"
        ? new Uint8Array(
            keep(
              vips.Image.thumbnailBuffer(new Uint8Array(source.bytes), THUMB_MAX, {
                height: THUMB_MAX,
                size: "down",
              }),
            ).writeToBuffer(THUMB_SUFFIX),
          )
        : thumbBytes(img);
    return { width: img.width, height: img.height, thumb };
  } finally {
    dispose();
  }
}

/** convert の 1 件の結果（SPEC §5.4）。`out` は非 SAB（Blob 化・transfer のため）。 */
export type ConvertedImage = {
  out: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  /** 元のバイト列をそのまま返した（再符号化していない）か。 */
  passedThrough?: boolean;
  /** libvips の版（`ConvertReport.producer.vips`）。 */
  vipsVersion: string;
};

/**
 * `bg` を vips の `background` 配列へ解決する（SPEC §5.4）。
 * バンド数に合わせるのは libvips の embed が画像と同じ本数を要求するため。
 * `average` は**縮小後の画像**から取る（参照実装 apply_contain と同じ）。
 */
function backgroundFor(img: VipsImage, bg: string): { value: number[]; needsAlpha: boolean } {
  // 透過背景は alpha 付きでないと表現できないので、3band / 1band なら addalpha を要求する
  // （参照実装 apply_contain.rs と同じ条件）。
  const needsAlpha = bg === BG_TRANSPARENT && (img.bands === 3 || img.bands === 1);
  const bands = needsAlpha ? img.bands + 1 : img.bands;

  if (bg === BG_AVERAGE) {
    const trash: VipsImage[] = [];
    try {
      // **1 パスで全 band の統計を出す。** band ごとに avg() を呼ぶと毎回パイプライン全体を
      // 評価し直すことになり、実測で contain が 124.8 → 163.6ms に伸びた（値は同一）。
      // stats() の行 1..bands が各バンド、列 4 が平均。
      const st = img.bands >= 3 ? trash[trash.push(img.stats()) - 1] : null;
      const whole = st ? 0 : img.avg();
      const bandAvg = (i: number): number => (st ? st.getpoint(4, i + 1)[0] : whole);
      return { value: backgroundVector("", bands, bandAvg), needsAlpha };
    } finally {
      for (const im of trash) im.delete();
    }
  }

  const rgb = bg === BG_TRANSPARENT ? null : (parseHexRgb(bg) ?? [255, 255, 255]);
  return {
    value: backgroundVector(bg, bands, (i) => rgb?.[i] ?? 255),
    needsAlpha,
  };
}

/**
 * 1 枚を変換する（SPEC §5.4）。`decodeCanonical` とは別経路で、
 * **`VipsImage` を保持したまま** resize / extractArea / embed を繋いでから符号化する
 * （decodeCanonical は RGBA のコピーしか返さないので変換には使えない）。
 *
 * EXIF の向きは適用する（`autorot`）。参照実装 `image_transform` は扱っていないが、
 * それだと iPhone の HEIC → PNG が倒れる。SPEC §5.4「EXIF の向き」を参照。
 */
export async function convertBuffer(
  bytes: ArrayBuffer,
  options: ConvertOptions,
  srcFormat: string,
): Promise<ConvertedImage> {
  // **デコードより先に「書けるか」を見る。** HEIC は補助デコーダで全画素を起こすので、
  // 書けない形式のために 48MP を解いてから失敗する、が一番高くつく。
  const outFormat = normalizeOutFormat(options.format ?? srcFormat);
  if (!saveSpec(outFormat, options.quality)) throw new Error(`${outFormat} には書き出せません`);
  return applyConvert(await getVips(), await toSource(bytes, srcFormat), options, srcFormat);
}

/**
 * [`convertBuffer`] の本体。**vips 実体を引数で受ける**ので、ブラウザ向けの `getVips()`
 * （`/vips/vips-es6.js` を URL で読む）に縛られず、node の vitest からも同じコードを試験できる。
 */
export function applyConvert(
  vips: Vips,
  source: DecodeSource,
  options: ConvertOptions,
  srcFormat: string,
): ConvertedImage {
  const { keep, dispose } = trashBag();
  try {
    const outFormat = normalizeOutFormat(options.format ?? srcFormat);
    let img = sourceImage(vips, source, keep);

    const plan = planGeometry({
      srcW: img.width,
      srcH: img.height,
      width: options.width,
      height: options.height,
      fit: options.fit,
      gravity: options.gravity,
    });

    // 「何も変えない」なら**再符号化せず元のバイト列を返す**（SPEC §5.4 規則 4）。
    // 判定は `passesThrough` が正本 —— 主線程（`convertSource`）と画面（`cannotWriteReason`）も
    // 同じ関数を通るので、三者がズレようが無い。寸法はデコード済みなので正しい値を返せる。
    //
    // **ここだけが余分に見る条件**: 元のバイト列が手元に在るか。補助デコーダ経由（HEVC の HEIC）は
    // `toSource` が生 RGBA に差し替えるので、返すべき「元の符号化」がこの場に残っていない。
    if (
      source.kind === "encoded" &&
      passesThrough(options, srcFormat, {
        noop: plan.kind === "noop",
        width: img.width,
        height: img.height,
      })
    ) {
      return {
        out: new Uint8Array(source.bytes),
        width: img.width,
        height: img.height,
        passedThrough: true,
        vipsVersion: vips.version(),
      };
    }

    if (plan.kind === "resize") {
      img = keep(img.resize(plan.scale));
    } else if (plan.kind === "fill") {
      img = keep(img.resize(plan.hscale, { vscale: plan.vscale }));
    } else if (plan.kind === "cover") {
      const resized = keep(img.resize(plan.scale));
      img = keep(
        resized.extractArea(plan.crop.left, plan.crop.top, plan.crop.width, plan.crop.height),
      );
    } else if (plan.kind === "contain") {
      const resized = plan.scale < 1 ? keep(img.resize(plan.scale)) : img;
      // **背景の既定は出力形式で決まる**（SPEC §5.4 規則 3）。形式が「入力と同じ」のときは
      // 1 件ごとに違うので、ここで初めて解決する（入口で一律に決めると png の余白が白くなる）。
      const bg = backgroundFor(resized, effectiveBackground(options.background, outFormat));
      const canvas = bg.needsAlpha ? keep(resized.addalpha()) : resized;
      img = keep(
        canvas.embed(plan.embed.x, plan.embed.y, plan.embed.width, plan.embed.height, {
          extend: "background",
          background: bg.value,
        }),
      );
    }

    const spec = saveSpec(outFormat, options.quality);
    // 書けない形式は**ここまで来ない**のが正（画面が実行前に止める）。念のため読める文言で。
    if (!spec) throw new Error(`${outFormat} には書き出せません`);
    // TIFF だけ保存前に sRGB へ寄せる（参照実装 save_image.rs と同じ）。
    const target = spec.needsSrgb ? keep(img.colourspace("srgb")) : img;
    // **wasm の例外はそのまま文字列にすると `[object WebAssembly.Exception]` にしかならない。**
    // ここは何をしようとして失敗したかが分かっているので、読める文言に言い換える。
    let out: Uint8Array<ArrayBuffer>;
    try {
      out = new Uint8Array(target.writeToBuffer(spec.suffix, spec.options));
    } catch (e) {
      throw new Error(`${outFormat} で書き出せませんでした`, { cause: e });
    }
    return { out, width: target.width, height: target.height, vipsVersion: vips.version() };
  } finally {
    dispose(); // wasm-vips のメモリは手動解放（leak 防止）。
  }
}
