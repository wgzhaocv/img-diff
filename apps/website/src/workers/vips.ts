// wasm-vips のロードとデコード（SPEC §1 手順 1〜3）。CLI の decode.rs / pipeline.rs の
// 2 層分離を JS 側でも踏襲し、scan（hash.worker）と compare（Phase 4）で decode→RGBA を共有する。
// 白平坦化・dHash（手順 4〜8）はしない。呼び出し側が core（imgdiff-wasm）で行う。

// --- wasm-vips の最小型（/vips/vips-es6.js を動的 import するため自前定義）。 ---
type VipsImage = {
  autorot(): VipsImage;
  colourspace(space: string): VipsImage;
  addalpha(): VipsImage;
  cast(format: string): VipsImage;
  writeToMemory(): Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly bands: number;
  delete(): void;
};
type Vips = {
  Image: { newFromBuffer(data: Uint8Array, strOptions?: string): VipsImage };
  concurrency(n: number): void;
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
        // HEIC/AVIF（libheif）と SVG（resvg）を有効化。jxl は CLI 非対応につき省く。
        dynamicLibraries: ["vips-heif.wasm", "vips-resvg.wasm"],
      });
      vips.concurrency(1); // シングルスレッド vips × N ワーカー（DESIGN §4）。
      return vips;
    })();
  }
  return vipsPromise;
}

export type DecodedImage = { rgba: Uint8Array<ArrayBuffer>; width: number; height: number };

/// バイト列を sRGB RGBA（straight alpha・uchar・4band・行優先）へデコードする。SPEC §1 手順 1〜3。
/// 手順は CLI `decode.rs::decode_canonical` と同順（autorot→sRGB→3band なら addalpha→cast uchar）。
/// bands が 3/4 以外は CLI 同様エラーにする（誤ハッシュを避け web/CLI 整合を保つ）。
export async function decodeCanonical(bytes: ArrayBuffer): Promise<DecodedImage> {
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
    // writeToMemory は vips（SharedArrayBuffer）ヒープ上の view を返し得る。非 SAB な ArrayBuffer へ
    // コピーして返す（delete 後も安全・crypto.subtle など BufferSource を要求する API にも渡せる）。
    const rgba = new Uint8Array(casted.writeToMemory());
    return { rgba, width, height };
  } finally {
    for (const im of trash) im.delete(); // wasm-vips のメモリは手動解放（leak 防止）。
  }
}
