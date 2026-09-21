import { normalizeOutFormat } from "@/lib/convertPlan";

// HEVC の HEIC を読むための**補助デコーダ**。
//
// 同梱の wasm-vips 0.0.18 の libheif は **HEVC のデコーダを含まない**
// （実測: `heif: Error while loading plugin: Support for this compression format has not been built in`）。
// AVIF（AV1）は読めるので、足りないのは HEVC だけ。libheif-js には libde265 が入っているので、
// **HEIC のときだけ**こちらで RGBA まで解いて wasm-vips へ渡す。
//
// **画素は原生 libvips と完全一致しない**（実測: 異なるバイト 29.9% / 最大差 11 /
// SSIM 0.99753）。YCbCr→RGB の色度補間の実装差で、dHash は 9×8 への縮小で
// ならされて一致する（実測 hamming 0）。詳細は SPEC §1。

/** この形式は wasm-vips では読めないので補助デコーダへ回す（heif は heic の別名）。 */
export function needsHeicDecoder(srcFormat: string): boolean {
  return normalizeOutFormat(srcFormat) === "heic";
}

/**
 * 中身が **AV1** の HEIF か（`.heic` / `.heif` でも中身が AV1 のことがある）。
 *
 * 補助デコーダ（libheif-js）は **HEVC しか持たない**。一方 wasm-vips 側の libheif は AV1 を読める。
 * 拡張子だけで振り分けると、AV1 入りの `.heic` が読めなくなる（この分岐を入れる前は読めていた）。
 * **失敗してから拾い直すのではなく、先に容器を見て振り分ける** —— そうすれば本物のエラー
 * （壊れている・時間切れ）が握り潰されずに表に出る。
 *
 * ISO BMFF の `ftyp` は先頭にあり、`[4..8)` が `"ftyp"`、`[8..12)` が major brand、
 * それ以降 4 バイトずつが compatible brands。
 */
export function isAv1Heif(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 64));
  const tag = (at: number): string => String.fromCharCode(...head.subarray(at, at + 4));
  if (head.length < 12 || tag(4) !== "ftyp") return false;
  const size = new DataView(head.buffer, head.byteOffset).getUint32(0);
  const end = Math.min(size, head.length);
  for (let at = 8; at + 4 <= end; at += 4) {
    const brand = tag(at);
    if (brand === "avif" || brand === "avis" || brand === "av01") return true;
  }
  return false;
}

type HeifImage = {
  get_width(): number;
  get_height(): number;
  display(
    out: { width: number; height: number; data: Uint8ClampedArray },
    cb: (result: unknown) => void,
  ): void;
  /** 画像ハンドルを解放する（`heif_image_handle_release`）。 */
  free(): void;
};

/**
 * `decode` の持ち手。**次の `decode` で前回の context を解放する**ので、使い回すこと
 * （試験は node 版から作った物を渡す。`applyConvert` が vips 実体を受けるのと同じ作法）。
 */
export type HeifDecoder = { decode(data: Uint8Array): HeifImage[] };

/** libheif の実体（試験は node 版を直接読んで渡す。`applyConvert` と同じ作法）。 */
export type LibHeif = { HeifDecoder: new () => HeifDecoder };

/** ワーカーごとに 1 つだけ持つ decoder（使い回さないと context が解放されない）。 */
let decoderPromise: Promise<HeifDecoder> | null = null;

/**
 * **decode を直列に流す。** libheif-js の `decode()` は最初に前回の context を解放するので、
 * 2 本が重なると先行の handle が宙に浮く（display 中の use-after-free、`free()` の二重解放）。
 * 今はワーカーが 1 度に 1 要求しか扱わないので重ならないが、**それは呼び出し側の事情**で、
 * ここからは見えない。見えない前提に頼らない。
 */
let chain: Promise<unknown> = Promise.resolve();

/** デコードが返ってこないときに諦めるまで（ms）。 */
const DECODE_TIMEOUT_MS = 120_000;

/** 壊れた可能性のある decoder を捨てる（次の取得で作り直される）。 */
function discardDecoder(): void {
  decoderPromise = null;
}

/**
 * libheif を（ワーカーごとに）一度だけ読む。**HEIC が実際に来るまで取りに行かない**
 * （wasm は 1.4MB。HEIC を扱わない利用者に払わせない）。
 */
export function getHeicDecoder(): Promise<HeifDecoder> {
  decoderPromise ??= (async () => {
    const mod = (await import("libheif-js/libheif-wasm/libheif.js")) as unknown as {
      default: (opts?: { locateFile?: (f: string) => string }) => Promise<LibHeif> | LibHeif;
    };
    // wasm は public/libheif へ実ファイルで置く（vite.config.ts）。
    const libheif = await mod.default({ locateFile: () => "/libheif/libheif.wasm" });
    return new libheif.HeifDecoder();
  })();
  return decoderPromise;
}

/**
 * HEIC を RGBA（straight alpha・uchar・4band・行優先）へ。
 *
 * 向きは libheif が irot/imir として**自分で適用する**ので、呼び出し側で `autorot` しない
 * （メモリ画像に EXIF は無い。原生 libvips もこの形式の EXIF Orientation では回さないことを実測）。
 * デコードできなければ**投げる** —— 画面は「読み込めません」と言える必要がある。
 */
export async function decodeHeicToRgba(
  bytes: ArrayBuffer,
): Promise<{ rgba: Uint8Array<ArrayBuffer>; width: number; height: number }> {
  return applyHeicDecode(await getHeicDecoder(), bytes);
}

/**
 * [`decodeHeicToRgba`] の本体。**libheif 実体を引数で受ける**ので、ブラウザ向けの
 * `getLibheif()`（`/libheif/libheif.wasm` を URL で読む）に縛られず node からも試験できる。
 */
export async function applyHeicDecode(
  decoder: HeifDecoder,
  bytes: ArrayBuffer,
): Promise<{ rgba: Uint8Array<ArrayBuffer>; width: number; height: number }> {
  const run = chain.then(
    () => decodeOne(decoder, bytes),
    () => decodeOne(decoder, bytes),
  );
  chain = run.catch(() => undefined); // 失敗しても後続を止めない
  return run;
}

async function decodeOne(
  decoder: HeifDecoder,
  bytes: ArrayBuffer,
): Promise<{ rgba: Uint8Array<ArrayBuffer>; width: number; height: number }> {
  // **decoder を使い回すこと。** libheif-js は「同じ decoder の次の decode()」でしか
  // 前回の heif_context を解放しないので、毎回 new すると解放経路に到達しない。
  // `heif_context_read_from_memory` はファイルを丸ごと libheif のヒープへ複製するため、
  // 1 枚ごとにファイルぶんが居座る（実測: 4.5KB の夹具 ×3000 回で +25.4MB、
  // 使い回し + free() で 0）。wasm のヒープは縮まないので、長い作業で効いてくる。
  const images = decoder.decode(new Uint8Array(bytes));
  let freeOnExit = true;
  try {
    const image = images[0];
    if (!image) throw new Error("HEIC に画像が入っていません");
    const width = image.get_width();
    const height = image.get_height();
    if (width <= 0 || height <= 0) throw new Error("HEIC の寸法を読めませんでした");
    const out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    // **時間切れを持つ。** `display` は内部で `setTimeout(async …)` を使っており、
    // その中で wasm が投げるとコールバックが**一度も呼ばれない**。待ち続けると
    // ワーカーが 1 本死んだまま戻らず、一覧が 499/500 で止まる。
    let timedOut = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("HEIC のデコードが終わりませんでした"));
        }, DECODE_TIMEOUT_MS);
        image.display(out, (result) => {
          clearTimeout(timer);
          if (result) resolve();
          else reject(new Error("HEIC のデコードに失敗しました"));
        });
      });
    } catch (e) {
      // **時間切れのときは handle を解放しない。** `display` を取り消す術が無いので、
      // まだ走っている可能性がある —— 解放すると、そいつが解放済みメモリへ書き込む。
      // 代わりに decoder ごと捨てる（次回は新しい context で始まる）。
      // 捨てた context は wasm ヒープに残るが、2 分かかる 1 枚の代償としては安い。
      if (timedOut) {
        freeOnExit = false;
        discardDecoder();
      }
      throw e;
    }
    // `out.data` は width*height*4 ちょうどの新しいバッファなので、view で足りる（複製しない）。
    return { rgba: new Uint8Array(out.data.buffer), width, height };
  } finally {
    if (freeOnExit) for (const im of images) im.free();
  }
}
