// convert の 1 件ぶん（SPEC §5.4）。**web が扱うのは 1 枚だけ**なので、ここに在るのは
// 「1 枚をワーカーへ投げて結果を受け取る」ことと、出力名の作り方だけ。
//
// バッチの編排（N 枚の有界並列・per-file の items/stats・出力先の注入）は畳んだ。
// 規則としては SPEC §5.4 に残してあるので、CLI を書くときはそちらを見る。

import type { ConvertOptions } from "schema";
import type { ConvertResult } from "@/lib/hashTypes";
import { type HashPool } from "@/lib/workerPool";
import { isPassThrough, normalizeOutFormat } from "@/lib/convertPlan";
import { extOf, stemOf } from "@/lib/imagePaths";

/** 変換対象（名前と、バイト列の取り方）。 */
export type ConvertSource = {
  /** 表示と出力名に使う名前。 */
  path: string;
  bytes: () => Promise<ArrayBuffer>;
};

/** 出力ファイル名（拡張子を出力形式へ差し替える）。形式を変えないなら元の名前のまま。 */
export function outPathFor(srcPath: string, outFormat: string | null): string {
  if (outFormat == null) return srcPath;
  return `${stemOf(srcPath)}.${normalizeOutFormat(outFormat)}`;
}

/** 出力バイト列と寸法。素通し（デコードしない）のときは寸法が 0。 */
type Output = {
  data: Uint8Array<ArrayBuffer>;
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
): Promise<Output> {
  const bytes = await src.bytes();
  if (isPassThrough(options, extOf(src.path))) {
    // 寸法はデコードしないと分からないので 0（SPEC §5.4: 素通しした項目の約束）。
    return {
      data: new Uint8Array(bytes) as Uint8Array<ArrayBuffer>,
      width: 0,
      height: 0,
      passedThrough: true,
    };
  }
  const res = (await pool.submit(
    { op: "convert", path: src.path, bytes, options, srcFormat: extOf(src.path) },
    [bytes],
  )) as ConvertResult;
  if (res.error != null || !res.out) throw new Error(res.error ?? "変換に失敗しました");
  return {
    data: res.out,
    width: res.width,
    height: res.height,
    vipsVersion: res.vipsVersion,
    // ワーカー側でも素通しは起こる（寸法を指定しても、その画像には効かないとき）。
    passedThrough: res.passedThrough ?? false,
  };
}
