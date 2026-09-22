/* tslint:disable */
/* eslint-disable */

/**
 * スコアと差分ハイライトを**同じ 1 回の受け渡しで**返す（SPEC §3 + §4）。**compare の唯一の出口。**
 *
 * 分けて呼ぶと 2 つ無駄が出る:
 *   1. a/b が**二度ずつ**線形メモリへ複製される（12MP 1 組で入り 4 枚ぶん + 出し 1 枚ぶん ≒ 240MB）。
 *      まとめれば入り 2 枚ぶん + 出し 1 枚ぶん ≒ 144MB。
 *   2. **差分の判定を二度なめる** —— `pixel_diff_ratio` と `highlight` は同じ `pixel_differs` を
 *      全画素に当てる。塗りながら数えれば 1 回で済む（`diff::highlight_counted`）。
 *
 * **値はビット一致**: 判定も範囲も同じで、`pixel_diff_ratio` は同じ式で数から作る
 * （`compare_all_matches_the_two_separate_calls` が固定している）。
 */
export class CompareAll {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 差分 RGBA を**取り出す**（2 度目は空になる）。JS へ渡す時点で 1 回だけ複製されるので、
     * getter として毎回複製するのを避ける。
     */
    take_diff(): Uint8Array;
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
 * 上の `CompareAll` を作る。
 */
export function compare_all(a: Uint8Array, b: Uint8Array, width: number, height: number, tolerance: number): CompareAll;

/**
 * 白平坦化済み RGBA から 9x8 dHash（16進16文字）を計算する。SPEC §1 手順 5〜8。
 */
export function dhash_hex(rgba: Uint8Array, width: number, height: number): string;

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
    readonly __wbg_compareall_free: (a: number, b: number) => void;
    readonly cluster_group: (a: any, b: number, c: number, d: number) => [number, number, number];
    readonly compare_all: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly compareall_pixel_diff_ratio: (a: number) => number;
    readonly compareall_psnr: (a: number) => number;
    readonly compareall_ssim: (a: number) => number;
    readonly compareall_take_diff: (a: number) => [number, number];
    readonly dhash_hex: (a: number, b: number, c: number, d: number) => [number, number];
    readonly flatten_and_dhash: (a: number, b: number, c: any, d: number, e: number) => [number, number];
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
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
