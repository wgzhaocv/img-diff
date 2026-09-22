import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ConvertOptions } from "schema";
import init from "@/wasm/imgdiff_wasm";
import { VIPS_DYNAMIC_LIBRARIES } from "@/workers/vipsLibs";
import type { Vips } from "@/workers/vips";

// 試験が共有する小道具（夹具の既定値と、重い初期化の手順）。
// **同じ手順を各試験ファイルが書き写さない** —— 書き写すと、そのうち片方だけが本番とずれる。

/**
 * 試験用の `ConvertOptions`。**欄を足したときに直すのはここ 1 箇所**
 * （以前は 4 つの試験ファイルが同じ 8 欄のリテラルを持っていて、既定値も割れ始めていた）。
 * 既定は「何も指定していない」状態。各ファイルはそこからの差分だけを書く。
 */
export function convertOptions(patch: Partial<ConvertOptions> = {}): ConvertOptions {
  return {
    width: null,
    height: null,
    fit: "cover",
    gravity: "center",
    background: null,
    format: null,
    quality: 80,
    forceReencode: false,
    ...patch,
  };
}

/**
 * 試験用の wasm-vips を起こす。**本番と同じ動的ライブラリ一覧**（`VIPS_DYNAMIC_LIBRARIES`）を使う
 * —— 以前は試験ごとに手書きしていて、`heic.test.ts` と `convertVips.test.ts` だけ resvg が
 * 抜けていた。そのせいで svg まわりの差が試験から一切見えなかった（`goldenDecode.test.ts` を
 * 書いたときに気づいた）。
 *
 * node 版のエントリを直接読む（ブラウザ版は `/vips/` の URL を前提にしていて node では動かない）。
 */
export async function bootVips(): Promise<Vips> {
  const mod = (await import("wasm-vips")) as unknown as {
    default: (cfg?: Record<string, unknown>) => Promise<Vips>;
  };
  const vips = await mod.default({ dynamicLibraries: VIPS_DYNAMIC_LIBRARIES });
  vips.concurrency(1);
  return vips;
}

/**
 * 試験用に core（imgdiff-wasm）を起こす。本番は `?url` で配られた実ファイルを取りに行くが、
 * node にはその URL が無いのでディスクから読んで渡す（読み込ませる wasm は同じ物）。
 */
export async function bootCore(): Promise<void> {
  await init({
    module_or_path: readFileSync(
      fileURLToPath(new URL("../src/wasm/imgdiff_wasm_bg.wasm", import.meta.url)),
    ),
  });
}
