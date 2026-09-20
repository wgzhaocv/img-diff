// wasm-vips のロードとデコード（SPEC §1 手順 1〜3）。CLI の decode.rs / pipeline.rs の
// 2 層分離を JS 側でも踏襲し、scan（hash.worker）と compare（Phase 4）で decode→RGBA を共有する。
// 白平坦化・dHash（手順 4〜8）はしない。呼び出し側が core（imgdiff-wasm）で行う。

import type { ConvertOptions } from "schema";
import {
  BG_AVERAGE,
  BG_TRANSPARENT,
  backgroundVector,
  effectiveBackground,
  normalizeOutFormat,
  parseHexRgb,
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

export type DecodedImage = {
  rgba: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  /** wantThumb 指定時の ~256px サムネ（webp バイト・原比率）。DESIGN §6。 */
  thumb?: Uint8Array<ArrayBuffer>;
};

/** サムネの最大辺（px）。DESIGN §6 の「~256px」。 */
const THUMB_MAX = 256;

/// バイト列を sRGB RGBA（straight alpha・uchar・4band・行優先）へデコードする。SPEC §1 手順 1〜3。
/// 手順は CLI `decode.rs::decode_canonical` と同順（autorot→sRGB→3band なら addalpha→cast uchar）。
/// bands が 3/4 以外は CLI 同様エラーにする（誤ハッシュを避け web/CLI 整合を保つ）。
/// wantThumb 指定時は、デコード済み画像から ~256px の webp サムネも生成する（デコードのついで・DESIGN §6）。
export async function decodeCanonical(
  bytes: ArrayBuffer,
  wantThumb = false,
): Promise<DecodedImage> {
  const vips = await getVips();
  const trash: VipsImage[] = [];
  try {
    const src = vips.Image.newFromBuffer(new Uint8Array(bytes));
    trash.push(src);
    const rotated = src.autorot();
    trash.push(rotated);
    const srgb = rotated.colourspace("srgb");
    trash.push(srgb);

    let rgbaImg: VipsImage;
    if (srgb.bands === 4) {
      rgbaImg = srgb;
    } else if (srgb.bands === 3) {
      rgbaImg = srgb.addalpha();
      trash.push(rgbaImg);
    } else {
      throw new Error(`想定外のバンド数 ${srgb.bands}（RGB/RGBA のみ対応）`);
    }
    const casted = rgbaImg.cast("uchar");
    if (casted !== rgbaImg) trash.push(casted);

    const { width, height } = casted;

    // サムネ（原比率で最大辺 256 に縮小・webp）。透過は premultiply→resize→unpremultiply でエッジの
    // フリンジを防ぐ。dHash 用の 9x8 とは別物。生成失敗は**致命でない**（dHash は成功済み）ので握り潰し
    // thumb 無しにする（表示は原 File / IDB にフォールバック）＝cosmetic な失敗で画像を dedup から落とさない。
    let thumb: Uint8Array<ArrayBuffer> | undefined;
    if (wantThumb) {
      try {
        const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
        const pm = casted.premultiply();
        trash.push(pm);
        const rs = pm.resize(scale);
        trash.push(rs);
        const um = rs.unpremultiply();
        trash.push(um);
        const uc = um.cast("uchar");
        if (uc !== um) trash.push(uc);
        thumb = new Uint8Array(uc.writeToBuffer(".webp[Q=80]"));
      } catch {
        thumb = undefined;
      }
    }

    // writeToMemory は vips（SharedArrayBuffer）ヒープ上の view を返し得る。非 SAB な ArrayBuffer へ
    // コピーして返す（delete 後も安全・crypto.subtle など BufferSource を要求する API にも渡せる）。
    const rgba = new Uint8Array(casted.writeToMemory());
    return { rgba, width, height, thumb };
  } finally {
    for (const im of trash) im.delete(); // wasm-vips のメモリは手動解放（leak 防止）。
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
export async function imageInfo(bytes: ArrayBuffer): Promise<ImageInfo> {
  return applyInfo(await getVips(), bytes);
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
export function applyInfo(vips: Vips, bytes: ArrayBuffer): ImageInfo {
  const trash: VipsImage[] = [];
  const keep = <T extends VipsImage>(im: T): T => {
    trash.push(im);
    return im;
  };
  try {
    const u8 = new Uint8Array(bytes);
    // 原寸はヘッダだけで分かる（autorot も遅延なので、ここでは画素を触らない）。
    const rotated = keep(keep(vips.Image.newFromBuffer(u8)).autorot());
    const { width, height } = rotated;
    const t = keep(vips.Image.thumbnailBuffer(u8, THUMB_MAX, { height: THUMB_MAX, size: "down" }));
    return { width, height, thumb: new Uint8Array(t.writeToBuffer(".webp[Q=80]")) };
  } finally {
    for (const im of trash) im.delete();
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
  return applyConvert(await getVips(), bytes, options, srcFormat);
}

/**
 * [`convertBuffer`] の本体。**vips 実体を引数で受ける**ので、ブラウザ向けの `getVips()`
 * （`/vips/vips-es6.js` を URL で読む）に縛られず、node の vitest からも同じコードを試験できる。
 */
export function applyConvert(
  vips: Vips,
  bytes: ArrayBuffer,
  options: ConvertOptions,
  srcFormat: string,
): ConvertedImage {
  const trash: VipsImage[] = [];
  /** 中間画像を捨て漏らさないための小道具（分岐が多いので都度 push する）。 */
  const keep = <T extends VipsImage>(im: T): T => {
    trash.push(im);
    return im;
  };
  try {
    const loaded = keep(vips.Image.newFromBuffer(new Uint8Array(bytes)));
    let img = keep(loaded.autorot());

    const outFormat = normalizeOutFormat(options.format ?? srcFormat);
    const plan = planGeometry({
      srcW: img.width,
      srcH: img.height,
      width: options.width,
      height: options.height,
      fit: options.fit,
      gravity: options.gravity,
    });

    // 寸法を指定していても、この画像には効かない（拡大要求など）ことがある。
    // 出力形式も同じなら**再符号化せず元のバイト列を返す**（SPEC §5.4 規則 4）。
    // 寸法はデコード済みなので、素通しでも正しい値を返せる。
    if (
      !options.forceReencode &&
      plan.kind === "noop" &&
      outFormat === normalizeOutFormat(srcFormat)
    ) {
      return {
        out: new Uint8Array(bytes),
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
    // TIFF だけ保存前に sRGB へ寄せる（参照実装 save_image.rs と同じ）。
    const target = spec.needsSrgb ? keep(img.colourspace("srgb")) : img;
    const out = new Uint8Array(target.writeToBuffer(spec.suffix, spec.options));
    return { out, width: target.width, height: target.height, vipsVersion: vips.version() };
  } finally {
    for (const im of trash) im.delete(); // wasm-vips のメモリは手動解放（leak 防止）。
  }
}
