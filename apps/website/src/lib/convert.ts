// convert の編排（SPEC §5.4）。N 枚を独立に変換してワーカー池へ流し、結果を per-file に集める。
// scan.ts と同じ作法: 末尾引数の onProgress / 1 件の失敗で止めない / path 昇順で決定的。
//
// **出力の落とし先は注入する**（`ConvertSink`）。フォルダへ書くのも zip に積むのも同じ本体を通り、
// 「どこへ置くか」だけが差し替わる（scan.ts::secondPassPixels と同じ形）。

import type { ConvertItem, ConvertOptions, ConvertStats } from "schema";
import type { ConvertResult } from "@/lib/hashTypes";
import type { HashPool } from "@/lib/workerPool";
import { normalizeOutFormat } from "@/lib/convertPlan";

export type ConvertProgress = { processed: number; total: number };

/** 変換対象 1 件（入力ルートからの相対パスと、バイト列の取り方）。 */
export type ConvertSource = {
  /** 入力ルートからの相対パス（'/' 区切り）。出力もこの構造を保つ。 */
  path: string;
  bytes: () => Promise<ArrayBuffer>;
};

/** 変換結果の落とし先。フォルダ書き出しと zip でこれだけが替わる。 */
export type ConvertSink = {
  /** 1 件を受け取る。既に在って上書きしない場合は `"skipped"` を返す。 */
  put: (path: string, data: Uint8Array<ArrayBuffer>) => Promise<"written" | "skipped">;
  /** 全件終わってからの締め（zip の生成など）。フォルダ書き出しでは何もしない。 */
  finish?: () => Promise<void>;
};

/** 出力ファイル名（拡張子を出力形式へ差し替える）。形式を変えないなら元の名前のまま。 */
export function outPathFor(srcPath: string, outFormat: string | null): string {
  if (outFormat == null) return srcPath;
  const f = normalizeOutFormat(outFormat);
  const slash = srcPath.lastIndexOf("/");
  const dot = srcPath.lastIndexOf(".");
  const stem = dot > slash ? srcPath.slice(0, dot) : srcPath;
  return `${stem}.${f}`;
}

/** 決定性のため path 昇順（localeCompare は環境差が出るので使わない・scan.ts と同じ）。 */
const byPath = (a: { src: string }, b: { src: string }): number =>
  a.src < b.src ? -1 : a.src > b.src ? 1 : 0;

/**
 * N 枚を変換する。1 件の失敗では止めず `ConvertItem.status = "failed"` に記録する（SPEC §5.4）。
 * 中断はプールの破棄で行う（`poolRef.reset()`）。そのとき進行中の submit が reject されるので、
 * 呼び出し側が catch して idle へ戻す。
 */
export async function runConvert(
  sources: ConvertSource[],
  options: ConvertOptions,
  sink: ConvertSink,
  pool: HashPool,
  poolSize: number,
  onProgress: (p: ConvertProgress) => void,
): Promise<{ items: ConvertItem[]; stats: ConvertStats }> {
  const started = performance.now();
  const total = sources.length;
  const items: ConvertItem[] = [];
  let processed = 0;

  // 同時実行数はプール本数に合わせる。狙いは並列度の制限ではなく**メモリ**
  // （出力バッファは入力と同程度以上になり得るので、先読みしすぎない）。
  await runBounded(sources, Math.max(1, poolSize), async (src) => {
    const dst = outPathFor(src.path, options.format);
    try {
      const bytes = await src.bytes();
      const res = (await pool.submit(
        { op: "convert", path: src.path, bytes, options, srcFormat: extOf(src.path) },
        [bytes],
      )) as ConvertResult;
      if (res.error != null || !res.out) {
        items.push({
          src: src.path,
          dst,
          width: 0,
          height: 0,
          bytes: 0,
          status: "failed",
          error: res.error ?? "変換に失敗しました",
        });
      } else {
        const status = await sink.put(dst, res.out);
        items.push({
          src: src.path,
          dst,
          width: res.width,
          height: res.height,
          bytes: status === "written" ? res.out.byteLength : 0,
          status: status === "written" ? "converted" : "skipped",
        });
      }
    } catch (e) {
      items.push({
        src: src.path,
        dst,
        width: 0,
        height: 0,
        bytes: 0,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      onProgress({ processed: ++processed, total });
    }
  });

  await sink.finish?.();
  items.sort(byPath);
  return {
    items,
    stats: {
      scanned: total,
      converted: items.filter((i) => i.status === "converted").length,
      skipped: items.filter((i) => i.status === "skipped").length,
      failed: items.filter((i) => i.status === "failed").length,
      elapsedMs: Math.round(performance.now() - started),
    },
  };
}

/** 拡張子（小文字・ドット無し）。出力形式が未指定のとき「元と同じ形式」を決めるのに使う。 */
function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot + 1).toLowerCase() : "";
}

/** 共有カーソルで N 本の runner を走らせる有界並列（scan.ts と同型）。 */
async function runBounded<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}
