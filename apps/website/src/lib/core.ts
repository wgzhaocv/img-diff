import init, { cluster_group } from "@/wasm/imgdiff_wasm";
import wasmUrl from "@/wasm/imgdiff_wasm_bg.wasm?url";
import type { DupGroup, ImageRecord, Strictness } from "schema";

// メインスレッドで imgdiff-wasm を初期化し、クラスタリング（SPEC §5）を呼ぶ。
// dHash/正規化と同じく grouping ロジックも core に一本化する（JS で再実装しない）。
// 型（Strictness / ImageRecord / DupGroup）は web/CLI 共有契約 `schema` を正本として使う。

export type { DupGroup, ImageRecord, Strictness } from "schema";

/// 厳密度のラベル（表示の単一定義。Tabs とグループ表示で共有）。
export const STRICTNESS_ORDER: readonly Strictness[] = ["exact", "pixel", "perceptual"];
export const STRICTNESS_LABEL: Record<Strictness, string> = {
  exact: "完全一致",
  pixel: "ピクセル一致",
  perceptual: "見た目が近い",
};

let ready: Promise<unknown> | null = null;
function ensureCore(): Promise<unknown> {
  if (!ready) ready = init(wasmUrl);
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
