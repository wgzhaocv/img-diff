import init, {
  cluster_group,
  compare_scores,
  diff_highlight,
  hamming_hex,
} from "@/wasm/imgdiff_wasm";
import wasmUrl from "@/wasm/imgdiff_wasm_bg.wasm?url";
import type { DupGroup, ImageRecord, Strictness } from "schema";

// メインスレッドで imgdiff-wasm を初期化し、クラスタリング（SPEC §5）を呼ぶ。
// dHash/正規化と同じく grouping ロジックも core に一本化する（JS で再実装しない）。
// 型（Strictness / ImageRecord / DupGroup）は web/CLI 共有契約 `schema` を正本として使う。

export type { DupGroup, ImageRecord, PlannedDeletion, Strictness } from "schema";

/// 厳密度のラベル（表示の単一定義。Tabs とグループ表示で共有）。
export const STRICTNESS_ORDER: readonly Strictness[] = ["exact", "pixel", "perceptual"];
export const STRICTNESS_LABEL: Record<Strictness, string> = {
  exact: "完全一致",
  pixel: "ピクセル一致",
  perceptual: "見た目が近い",
};

let ready: Promise<unknown> | null = null;
function ensureCore(): Promise<unknown> {
  // 単一オブジェクト形で渡す（位置引数は wasm-bindgen で deprecated 警告になる）。
  if (!ready) ready = init({ module_or_path: wasmUrl });
  return ready;
}

/// 索引済み画像を厳密度でグループ化する。threshold は perceptual のみ有効（未指定で既定 10）。
export async function clusterGroup(
  images: ImageRecord[],
  strictness: Strictness,
  threshold?: number,
): Promise<DupGroup[]> {
  await ensureCore();
  return cluster_group(images, strictness, threshold) as DupGroup[];
}

/// compare の連続値スコア（SPEC §3）。a/b は白平坦化済み・同寸法の RGBA。
export type CompareScoreValues = { pixelDiffRatio: number; ssim: number; psnr: number };

/// 2 枚の白平坦化 RGBA から pixelDiffRatio / SSIM / PSNR をまとめて計算する（境界越えは 1 回）。
/// wasm-bindgen のオブジェクトは明示解放が要るので getter を読んだら free する。
export async function compareScores(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  tolerance: number,
): Promise<CompareScoreValues> {
  await ensureCore();
  const s = compare_scores(a, b, width, height, tolerance);
  try {
    return { pixelDiffRatio: s.pixel_diff_ratio, ssim: s.ssim, psnr: s.psnr };
  } finally {
    s.free();
  }
}

/// 差分ハイライト RGBA（品紅=差分・淡グレー=ベース。SPEC §4）。a/b は白平坦化済み・同寸法。
/// wasm-bindgen は wasm 線形メモリから**新しい非共有 ArrayBuffer** にコピーして返すので
/// `Uint8Array<ArrayBuffer>` として扱える（canvas ImageData へそのまま view できる）。
export async function diffHighlight(
  a: Uint8Array,
  b: Uint8Array,
  tolerance: number,
): Promise<Uint8Array<ArrayBuffer>> {
  await ensureCore();
  return diff_highlight(a, b, tolerance) as Uint8Array<ArrayBuffer>;
}

/// 2 つの dHash（16進16文字）のハミング距離 0..=64。不正 hex は null。
export async function hammingHex(a: string, b: string): Promise<number | null> {
  await ensureCore();
  return hamming_hex(a, b) ?? null;
}
