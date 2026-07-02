import type { DecodeResult, WorkerRequest } from "@/lib/hashTypes";
import type { HashPool } from "@/lib/workerPool";
import { compareScores, diffHighlight, hammingHex } from "@/lib/core";
import { normalizeFormat } from "@/lib/scan";

// 2 枚比較（compare）のオーケストレーション。SPEC §3/§4・CLI compare.rs と同義。
// デコード + 白平坦化 + dHash はワーカー（op="decode"）で行い、ペア演算（compare_scores /
// diff_highlight / hamming）はメインの core で行う。両者とも比較には両画像の全分解能 RGBA が要るため、
// 2 枚だけなら worker→main へ transfer（コピー無し）して集約するのが素直。大画像で SSIM/diff が
// メインを一瞬 block し得るが、2 枚なので許容（scan の N 枚のような backpressure は不要）。

/// tolerance（各チャンネル差の許容）。CLI compare の既定と揃える。今は UI に露出しない。
const TOLERANCE = 0;

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

/// 2 枚のファイルを比較する。
export async function compareFiles(
  fileA: File,
  fileB: File,
  pool: HashPool,
): Promise<CompareOutcome> {
  const [da, db] = await Promise.all([decodeOne(pool, fileA), decodeOne(pool, fileB)]);

  const shaEqual = da.sha256 === db.sha256;
  const dimsEqual = da.width === db.width && da.height === db.height;
  const hammingDistance = da.phash && db.phash ? await hammingHex(da.phash, db.phash) : null;

  let pixelEqual: boolean | null = null;
  let pixelDiffRatio: number | null = null;
  let ssim: number | null = null;
  let psnr: number | null = null;
  let diff: CompareOutcome["diff"];

  // 比較不能（寸法不一致）時は数値は null（SPEC §3）。「比較不能」と「比較して不一致」を区別する。
  if (dimsEqual) {
    const scores = await compareScores(da.rgba, db.rgba, da.width, da.height, TOLERANCE);
    pixelDiffRatio = scores.pixelDiffRatio;
    ssim = scores.ssim;
    psnr = scores.psnr;
    // tolerance=0 では「差分ピクセル 0」＝「白平坦化 RGBA のバイト完全一致」＝ SPEC の pixelEqual。
    pixelEqual = pixelDiffRatio === 0;
    // diff_highlight は wasm メモリからコピー済みの新 Uint8Array（非 SAB）を返す → そのまま保持。
    const rgba = await diffHighlight(da.rgba, db.rgba, TOLERANCE);
    diff = { width: da.width, height: da.height, rgba };
  }

  return {
    a: toMeta(fileA, da),
    b: toMeta(fileB, db),
    shaEqual,
    dimsEqual,
    pixelEqual,
    pixelDiffRatio,
    ssim,
    psnr,
    hammingDistance,
    diff,
  };
}
