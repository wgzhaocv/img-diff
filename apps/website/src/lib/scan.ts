import type { HashResponse } from "@/lib/hashTypes";
import { HashPool } from "@/lib/workerPool";

// 対象拡張子（CLI の既定 ext と揃える）。
const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
  "svg",
]);

export function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext !== undefined && IMAGE_EXTS.has(ext);
}

export type ScanProgress = { processed: number; total: number };

/// items を最大 limit 本の runner で処理する。狙いは**同時実行制限ではなくメモリ**:
/// 各 runner は 1 件ずつ `file.arrayBuffer()` を読んで hash へ渡すので、全ファイルのバイトを
/// 一度に読み込まない（ワーカーの同時実行は HashPool 側が絞る。limit=poolSize で読み込みも歩調を合わせる）。
async function runBounded<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []; // 各 index に 1 度だけ代入する（完了時に密な length=items.length になる）。
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(runners);
  return results;
}

/// 画像ファイル群をプールでデコード + ハッシュする。バイト読み込みはワーカーの空きに合わせて遅延。
export async function scanFiles(
  files: File[],
  pool: HashPool,
  poolSize: number,
  onProgress: (p: ScanProgress) => void,
): Promise<HashResponse[]> {
  const targets = files.filter((f) => isImageFile(f.name));
  const total = targets.length;
  let processed = 0;
  onProgress({ processed, total });

  return runBounded(targets, poolSize, async (file, index) => {
    const bytes = await file.arrayBuffer();
    // フォルダ選択（webkitdirectory）なら相対パス、単ファイルなら名前。
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const path = relative && relative.length > 0 ? relative : file.name;
    const res = await pool.hash({ id: index, path, bytes }, [bytes]);
    processed += 1;
    onProgress({ processed, total });
    return res;
  });
}
