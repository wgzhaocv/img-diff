// 変換フォームの選択肢と、「今の指定でどの欄が出力に効くか」の判定（UI.md §6.1: 効かない控件は出さない）。
//
// **判定の根拠は実装側にしか無い**ので、画面のあちこちで同じ条件を書き写さずここに集める。
// 純関数（vips にも DOM にも依存しない）なので、そのまま試験できる。

import {
  isPassThrough,
  normalizeOutFormat,
  WRITABLE_FORMATS,
  parseDim,
  planGeometry,
  saveSpec,
  type ConvertPlan,
} from "@/lib/convertPlan";
import type { ConvertFit, ConvertGravity, ConvertOptions } from "schema";

/** 各欄を画面に出すか。false の欄は **DOM ごと出さない**（灰色で残さない）。 */
export type ControlRelevance = {
  fit: boolean;
  gravity: boolean;
  background: boolean;
  quality: boolean;
  /**
   * 寄せる位置のうち**実際に効く軸**。9 マスのどのボタンを見せるかに使う。
   * 原寸が分からないうちは両方 true（効かないと**証明できていない**ものは消さない）。
   */
  axes: { x: boolean; y: boolean };
};

/**
 * **全画素をメモリに載せないと書けない形式。**
 * libwebp / libheif / gif の量子化 / libjxl は逐行書き出しの口を持たないので、
 * libvips が流式に処理していても、保存の瞬間に幅×高さ×4 バイトを一度に要求する。
 * jpg と png は逐行で書けるので、6000×8000 でも通る（実測）。
 */
const WHOLE_IMAGE_SAVERS = ["webp", "avif", "gif", "jxl"];

/**
 * wasm のヒープで一度に載せられる画素数の上限（目安）。
 *
 * 実測: 6000×8000（48MP）の webp は `out of memory -- size == 137MB` で落ち、
 * 4000×3000（12MP）は通る。安全側に 16MP を境にする。
 */
const WHOLE_IMAGE_MAX_PIXELS = 16_000_000;

/**
 * その出力が**大きすぎて書けない**なら、理由を返す。
 * 落ちてから謝るのではなく、押す前に「寸法を小さくすれば書ける」と言うための判定。
 */
function tooLargeForFormat(outFormat: string, width: number, height: number): string | null {
  const f = normalizeOutFormat(outFormat);
  if (!WHOLE_IMAGE_SAVERS.includes(f)) return null;
  if (width * height <= WHOLE_IMAGE_MAX_PIXELS) return null;
  return `${width}×${height} のままでは ${f} に書き出せません（寸法を小さくしてください）`;
}

export { WRITABLE_FORMATS };

/** 合わせ方の全値。画面の分段コントロールと、保存済み設定の検証が共有する。 */
export const FIT_VALUES: ConvertFit[] = ["cover", "contain", "fill"];

/** 寄せる位置の全値。**3×3 に並べる順**（左上→右下）で持つ。 */
export const GRAVITY_VALUES: ConvertGravity[] = [
  "northwest",
  "north",
  "northeast",
  "west",
  "center",
  "east",
  "southwest",
  "south",
  "southeast",
];

/** 判定に要るフォームの部分（ConvertForm の一部。型を絞って試験しやすくする）。 */
export type RelevanceInput = {
  width: string;
  height: string;
  fit: ConvertFit;
  /** 空文字は「入力と同じ形式」。 */
  format: string;
};

/**
 * 出力形式が画質（`Q`）を受け取るか。
 *
 * **形式の一覧をここに書き写さない。** `saveSpec` が唯一の正本で、`Q` を渡さない形式
 * （png / tiff / gif / ppm）はそこで分岐している。写すと形式を足したときに片方だけ古くなる。
 */
export function qualityApplies(outFormat: string): boolean {
  const spec = saveSpec(outFormat, 80);
  return spec != null && "Q" in spec.options;
}

/**
 * 今の指定で効く欄を返す。
 *
 * - 合わせ方: 幅と高さの**両方**を指定したときだけ効く（SPEC §5.4 規則 2。
 *   片方だけなら `planGeometry` は等比縮小して `fit` を無視する）。
 * - 寄せる位置: 上に加えて `cover` / `contain` のときだけ（`fill` は gravity を使わない）。
 * - 背景色: 上に加えて `contain` のときだけ（背景は余白の埋めにしか使わない）。
 * - 画質: 実効出力形式が `Q` を取るときだけ。形式が「入力と同じ」なら**入力のどれか 1 つでも**
 *   該当すれば出す（1 件でも効くなら、指定できないと困る）。このとき、そもそも書き出せない
 *   形式（heic / svg）は数えない —— 出力形式が入力と同じならその件は必ず失敗するので、
 *   画質を出す理由にならない。
 */
export function relevantControls(
  form: RelevanceInput,
  srcFormats: string[],
  /**
   * **入力すべての原寸**（分かっているときだけ）。1 枚でも寸法が分からないなら `null` を渡すこと。
   *
   * 代表 1 枚だけで判断してはいけない —— 設定はバッチ全体に掛かるので、
   * 「正方形の代表には切り取りが起きないが、横長の 2 枚目には起きる」とき寄せる位置を隠すと、
   * **見えない設定が 2 枚目のどこを捨てるかを決めてしまう**。
   */
  srcs?: { width: number; height: number }[] | null,
): ControlRelevance {
  const width = parseDim(form.width);
  const height = parseDim(form.height);
  const fit = width != null && height != null;

  const out = form.format.trim();
  const quality =
    out === ""
      ? srcFormats.some((f) => {
          // `qualityApplies` は saveSpec に聞くので、書けない形式は自動的に false。
          return qualityApplies(f);
        })
      : qualityApplies(normalizeOutFormat(out));

  const known = (srcs ?? []).filter((s) => s.width > 0 && s.height > 0);
  // 全部の原寸が分かっているときだけ、計画（= 実際に走る算術）から答える。
  if (fit && srcs != null && known.length > 0 && known.length === srcs.length) {
    // どれか 1 枚でも効くなら出す（合併）。
    let axes = { x: false, y: false };
    let background = false;
    for (const src of known) {
      const plan = planGeometry({
        srcW: src.width,
        srcH: src.height,
        width,
        height,
        fit: form.fit,
        // gravity は余りの**配り方**しか決めない。軸の判定には影響しない。
        gravity: "center",
      });
      const a = gravityAxes(plan);
      axes = { x: axes.x || a.x, y: axes.y || a.y };
      // 背景は contain の余白にしか使わない（余白が出ないときは kind が contain にならない）。
      background = background || plan.kind === "contain";
    }
    return { fit, gravity: axes.x || axes.y, background, quality, axes };
  }

  // 原寸が分からない枚数が残っているときは、文字列から分かる範囲で答える
  // （効かないと**証明できていない**ものは消さない）。
  return {
    fit,
    gravity: fit && form.fit !== "fill",
    background: fit && form.fit === "contain",
    quality,
    axes: { x: true, y: true },
  };
}

/**
 * gravity の x / y 成分。**値の名前がそのまま `<y><x>` になっている**ので表は要らない
 * （`northwest` = north + west、`west` = west だけ、`center` = どちらも無し）。
 */
export function gravityParts(g: ConvertGravity): {
  x: "west" | "east" | "";
  y: "north" | "south" | "";
} {
  return {
    y: g.startsWith("north") ? "north" : g.startsWith("south") ? "south" : "",
    x: g.endsWith("west") ? "west" : g.endsWith("east") ? "east" : "",
  };
}

/** 成分から gravity へ戻す（両方空なら center）。 */
export function gravityFromParts(y: string, x: string): ConvertGravity {
  return (y + x || "center") as ConvertGravity;
}

/**
 * **その軸に余りが出るか。** 余りが 0 の軸では寄せる位置を変えても出力は 1 ピクセルも変わらない
 * （正方形を横長に切り抜くなら上下だけが効き、左右は無意味）。
 *
 * 判定は `planGeometry` が計画に載せた `slack` をそのまま読む
 * （同じ算術をここで書き直すと、丸め方を変えたときに画面と出力が食い違う）。
 */
export function gravityAxes(plan: ConvertPlan): { x: boolean; y: boolean } {
  if (plan.kind === "cover" || plan.kind === "contain") {
    return { x: plan.slack.x > 0, y: plan.slack.y > 0 };
  }
  // noop / resize / fill は寄せる位置を使わない。
  return { x: false, y: false };
}

/** 効かない軸の成分を中央へ寄せた、**出力が完全に同じ**gravity。 */
export function projectGravity(
  g: ConvertGravity,
  axes: { x: boolean; y: boolean },
): ConvertGravity {
  const p = gravityParts(g);
  return gravityFromParts(axes.y ? p.y : "", axes.x ? p.x : "");
}

/** 形式ごとの MIME（Blob を作って `<img>` に出すため）。 */
const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  tiff: "image/tiff",
  jxl: "image/jxl",
  ppm: "image/x-portable-pixmap",
};

export function mimeOf(outFormat: string): string {
  return MIME[normalizeOutFormat(outFormat)] ?? "application/octet-stream";
}

export function cannotWriteReason(
  options: ConvertOptions,
  srcFormat: string,
  /**
   * 計画の結果（原寸が分かるときだけ）。**worker と同じ条件で素通しを判定する**ために要る:
   * 「寸法を指定していても、その画像には効かない（= plan が noop）」なら元のバイト列が
   * そのまま出るので、書ける形式かどうかも大きさも関係ない。
   */
  planned?: { noop: boolean; width: number; height: number },
): string | null {
  const out = normalizeOutFormat(options.format ?? srcFormat);
  const sameFormat = out === normalizeOutFormat(srcFormat);
  // 素通し（vips.ts の早期 return と同じ条件）。原寸が分からないときは文字列だけで判断する。
  const passes = planned
    ? !options.forceReencode && planned.noop && sameFormat
    : isPassThrough(options, srcFormat);
  if (passes) return null;

  // 拡張子の無いファイルは `""` になる。**空文字は falsy なので、返すと「書ける」と誤判定される。**
  if (out === "") return "この形式 は書き出せません。出力形式を選んでください。";
  if (!WRITABLE_FORMATS.includes(out)) {
    return `${out} は書き出せません。出力形式を選んでください。`;
  }
  if (!planned) return null;
  return tooLargeForFormat(out, planned.width, planned.height);
}

/** MIME から拡張子へ（貼り付けた画像は名前に拡張子が無いことがある）。 */
export function extFromMime(mime: string): string | null {
  const m = mime.toLowerCase().split(";")[0].trim();
  return Object.entries(MIME).find(([, v]) => v === m)?.[0] ?? null;
}

/**
 * **ブラウザが素で描ける形式か。** wasm-vips が書けても `<img>` に出せるとは限らない
 * （jxl / tiff / ppm は出せない）。出せないときはプレビューの絵を諦めて数値だけ見せる。
 */
export function isBrowserRenderable(outFormat: string): boolean {
  const f = normalizeOutFormat(outFormat);
  return f === "jpg" || f === "png" || f === "webp" || f === "gif" || f === "avif";
}
