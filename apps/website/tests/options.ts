import type { ConvertOptions } from "schema";

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
