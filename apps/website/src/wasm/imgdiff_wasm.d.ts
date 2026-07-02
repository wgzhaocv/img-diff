/* tslint:disable */
/* eslint-disable */

/**
 * compare の連続値スコア（SPEC §3）。比較不能（寸法不一致）時は呼ばない前提。
 * `pixel_equal` と `hamming_distance` はここに含めない: 前者は JS が pixelSha256
 * （両画像の crypto.subtle）の一致で、後者は `hamming_hex` で導出する（いずれも CLI
 * `compare.rs`（pixel_sha256 一致 / hash::hamming）と同じ意味に揃える）。
 */
export class CompareScores {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly pixel_diff_ratio: number;
  readonly psnr: number;
  readonly ssim: number;
}

/**
 * 索引済み画像（`ImageRecord[]`）を厳密度でグループ化し `DupGroup[]` を返す。SPEC §5。
 * `strictness` は "exact" | "pixel" | "perceptual"。`threshold` は perceptual のみ有効（None で既定 10）。
 */
export function cluster_group(images: any, strictness: string, threshold?: number | null): any;

/**
 * 白平坦化済み・同寸法の RGBA 2 枚から連続値スコアをまとめて計算する（境界越えを 1 回に集約）。
 * SSIM は内部で Rec.601 グレー化してから計算する。SPEC §3。
 */
export function compare_scores(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  tolerance: number,
): CompareScores;

/**
 * 白平坦化済み RGBA から 9x8 dHash（16進16文字）を計算する。SPEC §1 手順 5〜8。
 */
export function dhash_hex(rgba: Uint8Array, width: number, height: number): string;

/**
 * 白平坦化済み・同寸法の RGBA 2 枚から差分ハイライト RGBA を返す（SPEC §4）。
 * 品紅=差分・淡グレー=ベース。可視化専用。
 */
export function diff_highlight(a: Uint8Array, b: Uint8Array, tolerance: number): Uint8Array;

/**
 * wasm-vips がデコードした RGBA（sRGB・autorotate 済）を**その場で白平坦化**し、
 * 9x8 dHash を 16進16文字で返す。`rgba` は破壊的に平坦化されて JS 側へ書き戻る。SPEC §1 手順 4〜8。
 *
 * 注意（DESIGN §2.1 の二段パス）: 書き戻った平坦化 RGBA を pixelSha256（crypto.subtle）に
 * 流用できるのは**全分解能デコード時のみ**。shrink-on-load（dHash 用に 9x8 相当へ縮小デコード）
 * では返るバイトは pixelSha256 の対象ではない。その場合は 1 パス目に `dhash_hex`（書き戻し無し）を、
 * 2 パス目（衝突バケットのみ再デコード）に `flatten_on_white` を使う。呼び分けは JS オーケストレータ側。
 */
export function flatten_and_dhash(rgba: Uint8Array, width: number, height: number): string;

/**
 * RGBA を背景白で平坦化する（in-place・alpha=255 化）。SPEC §1 手順 4。
 */
export function flatten_on_white(rgba: Uint8Array): void;

/**
 * 2 つの dHash（16進16文字）のハミング距離 0..=64。不正な hex は None（= undefined）。
 */
export function hamming_hex(a: string, b: string): number | undefined;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_comparescores_free: (a: number, b: number) => void;
  readonly cluster_group: (a: any, b: number, c: number, d: number) => [number, number, number];
  readonly compare_scores: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
  ) => number;
  readonly comparescores_pixel_diff_ratio: (a: number) => number;
  readonly comparescores_psnr: (a: number) => number;
  readonly comparescores_ssim: (a: number) => number;
  readonly dhash_hex: (a: number, b: number, c: number, d: number) => [number, number];
  readonly diff_highlight: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
  ) => [number, number];
  readonly flatten_and_dhash: (
    a: number,
    b: number,
    c: any,
    d: number,
    e: number,
  ) => [number, number];
  readonly flatten_on_white: (a: number, b: number, c: any) => void;
  readonly hamming_hex: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    | { module_or_path: InitInput | Promise<InitInput> }
    | InitInput
    | Promise<InitInput>,
): Promise<InitOutput>;
