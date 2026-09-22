/**
 * **wasm-vips が起動時に読み込む動的ライブラリ。ここが正本。**
 *
 * 3 箇所が同じ一覧を見る必要がある —— ワーカー（`vips.ts` の `getVips`）、
 * `vite.config.ts` の `copyWasmVips`（`public/vips` へ配る側）、そして node の試験。
 * **片方だけ足すと実行時に 404 する / 試験だけ本番と違う構成で走る**（実際、試験だけ
 * resvg を外していたせいで svg まわりの差が試験から一切見えなかった）。
 *
 * この束は**他を一切 import しない**。`vite.config.ts` から読めるようにするため ——
 * `vips.ts` 本体を読むと `@` 別名込みの src を config が引き込んでしまう。
 *
 * **init 時に全部読み込まれる**（emscripten の loadDylibs は遅延しない）。実測で
 * jxl の追加は +2.6ms / +7MB per worker、冷起動のバイト数は 9.27 → 11.34MB。
 * HEIC/AVIF は libheif、SVG は resvg、JXL は convert の入出力で使う
 * （JXL は CLI の Windows 版が libjxl 非同梱なので web のみ・SPEC §5.4）。
 */
export const VIPS_DYNAMIC_LIBRARIES = ["vips-heif.wasm", "vips-resvg.wasm", "vips-jxl.wasm"];

/** `public/vips` へ配るファイル一式（動的ライブラリ + 本体 + 入口）。 */
export const VIPS_RUNTIME_FILES = ["vips-es6.js", "vips.wasm", ...VIPS_DYNAMIC_LIBRARIES];
