// convert（SPEC §5.4）の**純粋な算術**。vips にも DOM にも依存しないので、そのまま単体試験できる。
// 実際の画素操作は workers/vips.ts が、ここが出した「計画」を vips の呼び出しへ写して行う。
//
// 引数の意味と効き方は参照実装 `image_transform` に合わせてある（SPEC §5.4 が正本）。
// 核は 4 つの規則: 拡大しない / `w`+`h` 両方でのみ fit が効く / bg 既定が出力形式で変わる / no-op 検出。

import type { ConvertFit, ConvertGravity, ConvertOptions } from "schema";

/** 透明背景を表す番人値（`ConvertOptions.background` に入り得る特別な綴り）。 */
export const BG_TRANSPARENT = "transparent";
/** 画像自身の平均色を背景にする番人値。 */
export const BG_AVERAGE = "average";

/**
 * 出力形式の別名を正規化する（`jpeg → jpg` / `tif → tiff` / `heif → heic`）。
 *
 * **`lib/scan.ts::normalizeFormat` とは方向が逆**（あちらは `jpg → jpeg`。`ImageRecord.format` を
 * CLI と揃えるための物）。用途が違う別の関数なので、**どちらかに寄せてはいけない**。
 */
export function normalizeOutFormat(fm: string): string {
  const f = fm.trim().toLowerCase().replace(/^\./, "");
  if (f === "jpeg") return "jpg";
  if (f === "tif") return "tiff";
  if (f === "heif") return "heic";
  return f;
}

/** 透過を保てる出力形式。`bg` を指定しなかったときの既定が `transparent` になる（SPEC §5.4 規則 3）。 */
const ALPHA_FORMATS = new Set(["png", "webp", "tiff"]);

/**
 * `bg` の実効値。未指定なら出力形式で決まる（png/webp/tiff は透明、それ以外は白）。
 * 呼び出し側は正規化後の形式を渡すこと。
 */
export function effectiveBackground(bg: string | null | undefined, outFormat: string): string {
  if (bg != null && bg !== "") return bg.trim().toLowerCase();
  return ALPHA_FORMATS.has(outFormat) ? BG_TRANSPARENT : "ffffff";
}

/**
 * 6 桁 hex を RGB へ。`#` は剥がす。**3 桁の短縮形は受け付けない**（参照実装と同じ）。
 * 解釈できなければ null を返すので、呼び出し側が入口で弾く。
 */
export function parseHexRgb(s: string): [number, number, number] | null {
  const hex = s.trim().toLowerCase().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/** `q` を 1..100 に丸める（範囲外はエラーにしない・SPEC §5.4）。 */
export function clampQuality(q: number): number {
  if (!Number.isFinite(q)) return 80;
  return Math.min(100, Math.max(1, Math.round(q)));
}

/** 画素を触らずそのまま返してよい、という計画（拡大要求・引数なし・結果が元と同じ）。 */
export type PlanNoop = { kind: "noop" };
/** 等比縮小だけ（`w` か `h` の片方だけ与えられたとき）。 */
export type PlanResize = { kind: "resize"; scale: number; width: number; height: number };
/** 縮小してから切り出す。 */
export type PlanCover = {
  kind: "cover";
  scale: number;
  crop: { left: number; top: number; width: number; height: number };
};
/** 縮小してから背景で埋めた画布へ置く。 */
export type PlanContain = {
  kind: "contain";
  scale: number;
  embed: { x: number; y: number; width: number; height: number };
};
/** 非等比に縮小（引き伸ばし）。 */
export type PlanFill = {
  kind: "fill";
  hscale: number;
  vscale: number;
  width: number;
  height: number;
};

export type ConvertPlan = PlanNoop | PlanResize | PlanCover | PlanContain | PlanFill;

export type PlanInput = {
  srcW: number;
  srcH: number;
  width: number | null;
  height: number | null;
  fit: ConvertFit;
  gravity: ConvertGravity;
};

/**
 * gravity から余り `d`（= 大きい方 − 小さい方、常に 0 以上）を左/上のオフセットへ配る。
 * cover の切り出し位置にも contain の余白配分にも同じ式を使う（SPEC §5.4 の表）。
 */
function offset(gravity: ConvertGravity, dx: number, dy: number): { x: number; y: number } {
  const cx = Math.floor(dx / 2);
  const cy = Math.floor(dy / 2);
  switch (gravity) {
    case "north":
      return { x: cx, y: 0 };
    case "south":
      return { x: cx, y: dy };
    case "west":
      return { x: 0, y: cy };
    case "east":
      return { x: dx, y: cy };
    case "northwest":
      return { x: 0, y: 0 };
    case "northeast":
      return { x: dx, y: 0 };
    case "southwest":
      return { x: 0, y: dy };
    case "southeast":
      return { x: dx, y: dy };
    case "center":
      return { x: cx, y: cy };
  }
}

/**
 * 寸法変更の計画を立てる（SPEC §5.4「算術」）。**画素には触らない。**
 *
 * - 拡大はしない: どの経路でも倍率は 1.0 で頭打ちになり、1.0 なら `noop`。
 * - `width` と `height` の**両方**が在るときだけ `fit` / `gravity` が効く。片方だけなら等比縮小。
 */
export function planGeometry(input: PlanInput): ConvertPlan {
  const { srcW, srcH, width, height, fit, gravity } = input;
  if (srcW <= 0 || srcH <= 0) return { kind: "noop" };

  // 片側だけ / どちらも無い → 等比縮小（fit も gravity も無視する）。
  if (width == null || height == null) {
    const target = width ?? height;
    if (target == null || target <= 0) return { kind: "noop" };
    const scale = Math.min(target / (width != null ? srcW : srcH), 1);
    if (scale >= 1) return { kind: "noop" };
    return {
      kind: "resize",
      scale,
      width: Math.round(srcW * scale),
      height: Math.round(srcH * scale),
    };
  }
  if (width <= 0 || height <= 0) return { kind: "noop" };

  if (fit === "fill") {
    const hscale = Math.min(width / srcW, 1);
    const vscale = Math.min(height / srcH, 1);
    if (hscale >= 1 && vscale >= 1) return { kind: "noop" };
    return {
      kind: "fill",
      hscale,
      vscale,
      width: Math.round(srcW * hscale),
      height: Math.round(srcH * vscale),
    };
  }

  if (fit === "cover") {
    // 元が両辺とも目標以下なら**そのまま返す**（参照実装 apply_cover の先頭と同じ）。
    if (srcW <= width && srcH <= height) return { kind: "noop" };
    const scale = Math.min(Math.max(width / srcW, height / srcH), 1);
    const midW = Math.round(srcW * scale);
    const midH = Math.round(srcH * scale);
    // 拡大しない縛りのため、目標が中間寸法より大きいことが有り得る。その場合は切り出せる分だけ。
    const cw = Math.min(width, midW);
    const ch = Math.min(height, midH);
    const { x, y } = offset(gravity, midW - cw, midH - ch);
    return { kind: "cover", scale, crop: { left: x, top: y, width: cw, height: ch } };
  }

  // contain: 縮小して、目標寸法の画布へ背景で埋めて置く。
  // **contain は常に目標寸法を返す**（参照実装 calculate_contain_size の注記）ので、
  // 拡大しない縛りで縮小が起きなくても、目標が元より大きければ背景で埋める。
  const scale = Math.min(Math.min(width / srcW, height / srcH), 1);
  const midW = Math.round(srcW * scale);
  const midH = Math.round(srcH * scale);
  // 縮小結果がちょうど目標寸法なら埋める余白が無い（参照実装もここで早期に返す）。
  if (midW === width && midH === height) {
    return scale >= 1 ? { kind: "noop" } : { kind: "resize", scale, width: midW, height: midH };
  }
  const { x, y } = offset(gravity, Math.max(0, width - midW), Math.max(0, height - midH));
  return { kind: "contain", scale, embed: { x, y, width, height } };
}

/**
 * 変換の指定が「何もしない」と同義かどうか（SPEC §5.4 規則 4 の前半）。
 * 形式も寸法も変えないなら、デコードすらせず元のバイト列を返せる。
 */
export function isNoopRequest(o: ConvertOptions, srcFormat: string): boolean {
  const formatChanges = o.format != null && o.format !== normalizeOutFormat(srcFormat);
  const resizes = o.width != null || o.height != null;
  return !formatChanges && !resizes;
}

/** `writeToBuffer` へ渡す保存指定。 */
export type SaveSpec = {
  suffix: string;
  /**
   * 保存器のオプション。**接尾辞の文字列に混ぜてはいけない** —— 文字列形式はキーを連字符で書く
   * 必要があり、下線で書くと**例外も警告も出さずに黙って無視される**（実測）。
   * オブジェクト形式は wasm-vips の型定義どおり下線で、TS が綴りを検査してくれる。
   */
  options: Record<string, unknown>;
  /** TIFF だけ保存前に sRGB へ変換する（参照実装 save_image.rs と同じ）。 */
  needsSrgb: boolean;
};

/**
 * 形式ごとの保存指定（参照実装 `save_image.rs` と同じ設定）。
 * png / gif / ppm は品質を受け付けないので `Q` を渡さない（渡すと libvips が失敗する）。
 */
export function saveSpec(outFormat: string, quality: number): SaveSpec {
  const f = normalizeOutFormat(outFormat);
  const Q = clampQuality(quality);
  switch (f) {
    case "jpg":
      // subsample_mode:"off" は色度間引きを止める＝見て分かる品質差になるので落とせない。
      return {
        suffix: ".jpg",
        options: { Q, optimize_coding: true, subsample_mode: "off" },
        needsSrgb: false,
      };
    case "png":
      return {
        suffix: ".png",
        options: { compression: 6, filter: "none", effort: 4 },
        needsSrgb: false,
      };
    case "webp":
      return {
        suffix: ".webp",
        options: { Q, effort: 4, smart_subsample: true },
        needsSrgb: false,
      };
    case "tiff":
      return {
        suffix: ".tiff",
        options: { compression: "lzw", predictor: "horizontal" },
        needsSrgb: true,
      };
    case "gif":
      return {
        suffix: ".gif",
        options: { effort: 4, interpalette_maxerror: 3 },
        needsSrgb: false,
      };
    case "avif":
      return { suffix: ".avif", options: { Q, compression: "av1" }, needsSrgb: false };
    default:
      // jxl（web のみ）と ppm など。ppm は Q を受け付けないので付けない。
      return { suffix: `.${f}`, options: f === "ppm" ? {} : { Q }, needsSrgb: false };
  }
}

/**
 * バンド数に合わせた背景ベクタを作る（SPEC §5.4）。
 * **libvips の `embed` は画像と同じ本数（または 1 本）を要求し、足りないと例外を投げる**
 * ので、グレースケール（1band）やグレー+アルファ（2band）も必ず扱うこと。
 * 参照実装 `apply_contain.rs` の分岐と同じ。
 */
export function backgroundVector(
  bg: string,
  bands: number,
  rgbOf: (i: number) => number,
): number[] {
  if (bg === BG_TRANSPARENT) {
    // 3band/1band は呼び出し側が addalpha 済みの想定だが、そうでない形にも定義を与える。
    if (bands === 4) return [0, 0, 0, 0];
    if (bands === 2) return [255, 0];
    if (bands === 1) return [255];
    return [255, 255, 255]; // alpha を足せない形＝白へ退避（参照実装と同じ）
  }
  const [r, g, b] = [rgbOf(0), rgbOf(1), rgbOf(2)];
  const gray = r * 0.299 + g * 0.587 + b * 0.114;
  if (bands === 4) return [r, g, b, 255];
  if (bands === 2) return [gray, 255];
  if (bands === 1) return [gray];
  return [r, g, b];
}
