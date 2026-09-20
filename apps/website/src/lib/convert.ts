// convert の編排（SPEC §5.4）。N 枚を独立に変換してワーカー池へ流し、結果を per-file に集める。
// scan.ts と同じ作法: 末尾引数の onProgress / 1 件の失敗で止めない / path 昇順で決定的。
//
// **出力の落とし先は注入する**（`ConvertSink`）。フォルダへ書くのも zip に積むのも同じ本体を通り、
// 「どこへ置くか」だけが差し替わる（scan.ts::secondPassPixels と同じ形）。

import type { ConvertItem, ConvertOptions, ConvertStats } from "schema";
import type { ConvertResult } from "@/lib/hashTypes";
import { PoolAbortError, type HashPool } from "@/lib/workerPool";
import { isPassThrough, normalizeOutFormat } from "@/lib/convertPlan";
import { errText } from "@/lib/format";
import { compareCodepoint, extOf } from "@/lib/imagePaths";

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
  /** 全件終わってからの締め（zip の中央ディレクトリ書き出しなど）。フォルダ書き出しでは何もしない。 */
  finish?: () => Promise<void>;
  /**
   * 中断・異常終了したときの後始末。**`finish` と排他**。
   * これが無いと、流し込み中の zip が中央ディレクトリを書かないまま宙に浮き、
   * 書き込み先のストリームも閉じられない。
   */
  abort?: (reason: unknown) => Promise<void>;
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

/** 決定性のため src 昇順（比較子は共有・SPEC §4）。 */
const byPath = (a: { src: string }, b: { src: string }): number => compareCodepoint(a.src, b.src);

/**
 * **同じ実行の中で出力名が衝突しないか**を、変換を始める前に調べる（SPEC §5.4）。
 *
 * 形式を変えると `a.jpg` と `a.png` がどちらも `a.webp` になる。衝突は 1 件ずつ見ていても
 * 気づけない（集合の性質）ので、ここで一括して検出する。放置すると:
 * フォルダ出力では**先に書けた方が勝ち、負けた方は「既に在るので skip」と同じ状態で報告される**
 * （どちらが勝つかは並列の交錯次第＝非決定的）。zip では同名の項目が 2 つ入る。
 * どちらも「N 件変換した」と言いながら実際には減っている、という最悪の形になる。
 */
export function findOutputCollisions(
  sources: { path: string }[],
  outFormat: string | null,
): { dst: string; srcs: string[] }[] {
  const byDst = new Map<string, string[]>();
  for (const s of sources) {
    const dst = outPathFor(s.path, outFormat);
    byDst.set(dst, [...(byDst.get(dst) ?? []), s.path]);
  }
  return [...byDst]
    .filter(([, srcs]) => srcs.length > 1)
    .map(([dst, srcs]) => ({ dst, srcs: [...srcs].sort(compareCodepoint) }))
    .sort((a, b) => compareCodepoint(a.dst, b.dst));
}

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

  try {
    // 同時実行数はプール本数に合わせる。狙いは並列度の制限ではなく**メモリ**
    // （出力バッファは入力と同程度以上になり得るので、先読みしすぎない）。
    await runBounded(sources, Math.max(1, poolSize), async (src) => {
      const dst = outPathFor(src.path, options.format);
      try {
        const bytes = await src.bytes();
        // この 1 件に変換の必要が無いなら**デコードせず元のバイト列を渡す**（SPEC §5.4 規則 4）。
        // 再符号化すると何も変えていないのに圧縮とメタデータが変わる。混在バッチで
        // 「既に目的の形式だったファイル」や、読めるが書けない HEIC がここを通る。
        const out = isPassThrough(options, extOf(src.path))
          ? // 寸法はデコードしないと分からないので 0（SPEC §5.4: 素通しした項目の約束）。
            { data: new Uint8Array(bytes) as Uint8Array<ArrayBuffer>, width: 0, height: 0 }
          : await convertOne(pool, src.path, bytes, options);
        const status = await sink.put(dst, out.data);
        items.push({
          src: src.path,
          dst,
          width: out.width,
          height: out.height,
          bytes: status === "written" ? out.data.byteLength : 0,
          status: status === "written" ? "converted" : "skipped",
        });
      } catch (e) {
        // **中断は「1 件の失敗」ではない。** 握り潰すと残り全部を failed として記録したまま
        // 正常終了し、「中断したのに N 件変換・M 件失敗」と表示されてしまう。
        if (e instanceof PoolAbortError) throw e;
        items.push({
          src: src.path,
          dst,
          width: 0,
          height: 0,
          bytes: 0,
          status: "failed",
          error: errText(e),
        });
      } finally {
        onProgress({ processed: ++processed, total });
      }
    });
    await sink.finish?.();
  } catch (e) {
    // 中断でも編排の失敗でも、開きっぱなしの出力を必ず畳む
    // （zip なら中央ディレクトリを書かないまま宙に浮かせない）。
    await sink.abort?.(e);
    throw e;
  }

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

/** 出力バイト列と寸法。素通し（デコードしない）のときは寸法が 0。 */
type Output = { data: Uint8Array<ArrayBuffer>; width: number; height: number };

/** ワーカーへ 1 件投げる。エラーは戻り値で来るので投げ直して呼び出し側の catch に束ねる。 */
async function convertOne(
  pool: HashPool,
  path: string,
  bytes: ArrayBuffer,
  options: ConvertOptions,
): Promise<Output> {
  const res = (await pool.submit({ op: "convert", path, bytes, options, srcFormat: extOf(path) }, [
    bytes,
  ])) as ConvertResult;
  if (res.error != null || !res.out) throw new Error(res.error ?? "変換に失敗しました");
  return { data: res.out, width: res.width, height: res.height };
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
