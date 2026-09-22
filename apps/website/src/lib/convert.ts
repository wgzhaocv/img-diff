// convert の 1 件ぶん（SPEC §5.4）。**web が扱うのは 1 枚だけ**なので、ここに在るのは
// 「1 枚をワーカーへ投げて結果を受け取る」ことと、出力名の作り方だけ。
//
// バッチの編排（N 枚の有界並列・per-file の items/stats・出力先の注入）は畳んだ。
// 規則としては SPEC §5.4 に残してあるので、CLI を書くときはそちらを見る。

import type { ConvertOptions } from "schema";
import type { ConvertResult } from "@/lib/hashTypes";
import { type HashPool } from "@/lib/workerPool";
import { normalizeOutFormat, passesThrough, type PlannedOutput } from "@/lib/convertPlan";
import { extOf, stemOf } from "@/lib/imagePaths";

/**
 * 変換対象。**中身は `Blob` のまま持つ**（読むのはワーカー側）——
 * `Blob` は構造化複製で参照ごと運ばれるので、主線程はファイルを読まずに渡せる。
 */
export type ConvertSource = {
  /** 表示と出力名に使う名前。 */
  path: string;
  file: Blob;
};

/** 出力ファイル名（拡張子を出力形式へ差し替える）。形式を変えないなら元の名前のまま。 */
export function outPathFor(srcPath: string, outFormat: string | null): string {
  if (outFormat == null) return srcPath;
  return `${stemOf(srcPath)}.${normalizeOutFormat(outFormat)}`;
}

/** 出力と寸法。素通し（デコードしない）のときは寸法が 0。 */
type Output = {
  /** 変換後の中身。**素通しでは元の `Blob` をそのまま切り出した物**（読みもコピーもしない）。 */
  blob: Blob;
  width: number;
  height: number;
  vipsVersion?: string;
  /** 元のバイト列をそのまま返した（再符号化していない）か。SPEC §5.4 規則 4。 */
  passedThrough: boolean;
};

/**
 * **1 枚を変換する唯一の入口。**
 *
 * 変換の必要が無いなら**デコードせず元のバイト列を返す**（SPEC §5.4 規則 4）。
 * 再符号化すると何も変えていないのに圧縮とメタデータが変わる。既に目的の形式だった画像や、
 * 読めるが書けない HEIC がここを通る。
 */
export async function convertSource(
  src: ConvertSource,
  options: ConvertOptions,
  pool: HashPool,
  outMime: string,
  planned?: PlannedOutput,
): Promise<Output> {
  const srcFormat = extOf(src.path);
  if (passesThrough(options, srcFormat, planned)) {
    // **1 バイトも読まない。** `slice` は中身を複製せず、型だけ付け替えた view を返す。
    // 寸法はデコードしないと分からないので 0（SPEC §5.4: 素通しした項目の約束）。
    //
    // **ここが唯一「読めるが書けない形式」を救える場所。** ワーカー側にも同じ早期 return は在るが、
    // あちらは `convertBuffer` の `saveSpec` 検査より後ろなので、heic は辿り着く前に投げる。
    // 加えて HEVC の heic は `toSource` が生 RGBA に差し替えるので元のバイト列が残らない。
    // 主線程は常に元の `Blob` を持っているので、規則 4 の「元のバイト列を出す」を満たせる。
    return {
      blob: src.file.slice(0, src.file.size, outMime),
      width: 0,
      height: 0,
      passedThrough: true,
    };
  }
  const res = (await pool.submit(
    { op: "convert", path: src.path, blob: src.file, options, srcFormat },
    [],
  )) as ConvertResult;
  if (res.error != null || !res.out) throw new Error(res.error ?? "変換に失敗しました");
  return {
    blob: new Blob([res.out], { type: outMime }),
    width: res.width,
    height: res.height,
    vipsVersion: res.vipsVersion,
    // ワーカー側でも素通しは起こる（寸法を指定しても、その画像には効かないとき）。
    passedThrough: res.passedThrough ?? false,
  };
}
