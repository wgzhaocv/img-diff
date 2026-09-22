import type { DecodeResult, ScoreResult, WorkerRequest } from "@/lib/hashTypes";
import type { HashPool } from "@/lib/workerPool";
import { normalizeFormat } from "@/lib/scan";

// 2 枚比較（compare）のオーケストレーション。SPEC §3/§4・CLI compare.rs と同義。
// **計算は全部ワーカー側**で行う: デコード + 白平坦化 + dHash（op="decode"）に続けて、
// 採点と差分ハイライト（op="score"）も投げる。
//
// 採点だけは両画像の全分解能 RGBA が同時に要るので、一度主線程へ戻った RGBA をもう一度
// ワーカーへ送り返す。**送り返しは transfer なので複製は起きない**（払うのは往復 1 回ぶんだけ）。
// これを主線程でやると、12MP 2 枚で SSIM と差分の間ずっと画面が固まる —— そこが直したかった所。
// 副産物として `/compare` は主線程の imgdiff-wasm を一度も起こさなくなった（ハミングも向こうで出す）。

/// tolerance（各チャンネル差の許容）。CLI compare の既定と揃える。今は UI に露出しない。
const TOLERANCE = 0;

/// 比較の進行フェーズ（UI で「今なにをしているか」を出すため）。
/// decode=2 枚のデコード（初回はワーカーごとの wasm-vips 初期化コミ・ここが一番重い）、
/// score=SSIM/PSNR/差分割合と差分ハイライト（ワーカー側で 1 回にまとめて計算する）。
export type ComparePhase = "decode" | "score";

/// 比較対象 1 枚のメタ（表示用。ImageRecord の compare で意味を持つ部分集合）。
export type CompareImageMeta = {
  name: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  sha256: string;
  phash: string | null;
};

/// 2 枚比較の結果（CompareResult・SPEC §3 の表示に必要な部分 + 差分 RGBA）。
export type CompareOutcome = {
  a: CompareImageMeta;
  b: CompareImageMeta;
  /** SHA-256 一致（= 完全同一ファイル）。 */
  shaEqual: boolean;
  /** 寸法一致（= ピクセル比較が可能か）。false の間、下の数値は null。 */
  dimsEqual: boolean;
  /** デコード後ピクセル一致（bytes 完全一致）。比較不能時は null。 */
  pixelEqual: boolean | null;
  pixelDiffRatio: number | null;
  ssim: number | null;
  psnr: number | null;
  /** dHash ハミング距離 0..64。どちらかがデコード失敗なら null。 */
  hammingDistance: number | null;
  /** 差分ハイライト RGBA（品紅=差分・淡グレー=ベース）。dimsEqual のときのみ。 */
  diff?: { width: number; height: number; rgba: Uint8Array<ArrayBuffer> };
};

/// 1 枚を worker でデコード（sha256 + dHash + 白平坦化 RGBA）。失敗は例外にする（呼び出し側で toast）。
/// rgba を必ず返す型に絞り、呼び出し側の二重 null ガードを不要にする。
async function decodeOne(
  pool: HashPool,
  file: File,
): Promise<DecodeResult & { rgba: Uint8Array<ArrayBuffer> }> {
  const bytes = await file.arrayBuffer();
  const req: WorkerRequest = { op: "decode", path: file.name, bytes };
  const res = await pool.submit(req, [bytes]);
  if (res.op !== "decode") throw new Error("ワーカーから想定外の応答を受け取りました");
  if (res.error || !res.rgba)
    throw new Error(res.error ?? `${file.name} をデコードできませんでした`);
  return res as DecodeResult & { rgba: Uint8Array<ArrayBuffer> };
}

/// 突き合わせをワーカーへ投げる（`op:"score"`）。寸法が一致していれば画素も一緒に渡す。
/// RGBA は transfer なので**複製されない**代わりに、**戻った後の `da.rgba` / `db.rgba` は
/// detach されて使えなくなる** —— 呼び出し側はもう読まない。
async function scorePair(
  pool: HashPool,
  da: DecodeResult & { rgba: Uint8Array<ArrayBuffer> },
  db: DecodeResult & { rgba: Uint8Array<ArrayBuffer> },
  withPixels: boolean,
): Promise<ScoreResult> {
  const pixels = withPixels
    ? {
        a: da.rgba.buffer,
        b: db.rgba.buffer,
        width: da.width,
        height: da.height,
        tolerance: TOLERANCE,
      }
    : undefined;
  const req: WorkerRequest = { op: "score", phashA: da.phash, phashB: db.phash, pixels };
  const res = await pool.submit(req, pixels ? [pixels.a, pixels.b] : []);
  if (res.op !== "score") throw new Error("ワーカーから想定外の応答を受け取りました");
  if (res.error) throw new Error(res.error);
  return res;
}

function toMeta(file: File, d: DecodeResult): CompareImageMeta {
  return {
    name: file.name,
    width: d.width,
    height: d.height,
    bytes: d.bytes,
    format: normalizeFormat(file.name),
    sha256: d.sha256,
    phash: d.phash,
  };
}

/// 2 枚のファイルを比較する。onProgress で「今どのフェーズか」を通知する（UI の進捗表示用）。
export async function compareFiles(
  fileA: File,
  fileB: File,
  pool: HashPool,
  onProgress?: (phase: ComparePhase) => void,
): Promise<CompareOutcome> {
  onProgress?.("decode");
  const [da, db] = await Promise.all([decodeOne(pool, fileA), decodeOne(pool, fileB)]);

  const shaEqual = da.sha256 === db.sha256;
  const dimsEqual = da.width === db.width && da.height === db.height;

  // 比較不能（寸法不一致）時は連続値を出さない（SPEC §3）。
  // 「比較不能」と「比較して不一致」を区別する。ハミング距離は層に依らず常に出す。
  if (dimsEqual) onProgress?.("score");
  const scored = await scorePair(pool, da, db, dimsEqual);
  // tolerance=0 では「差分ピクセル 0」＝「白平坦化 RGBA のバイト完全一致」＝ SPEC の pixelEqual。
  const pixelEqual = scored.pixelDiffRatio == null ? null : scored.pixelDiffRatio === 0;
  // 差分はワーカーから transfer で来た非 SAB の Uint8Array → そのまま保持（canvas へ view できる）。
  const diff = scored.diff ? { width: da.width, height: da.height, rgba: scored.diff } : undefined;

  return {
    a: toMeta(fileA, da),
    b: toMeta(fileB, db),
    shaEqual,
    dimsEqual,
    pixelEqual,
    pixelDiffRatio: scored.pixelDiffRatio,
    ssim: scored.ssim,
    psnr: scored.psnr,
    hammingDistance: scored.hammingDistance,
    diff,
  };
}
