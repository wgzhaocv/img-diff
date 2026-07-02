import type { ImageRecord } from "schema";
import type { HashResult, PixelResult } from "@/lib/hashTypes";
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

// CLI `util.rs::normalize_ext` と揃える（producer 間で ImageRecord.format を一致させる）。
const FORMAT_ALIAS: Record<string, string> = { jpg: "jpeg", tif: "tiff" };

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name));
}

export type ScanPhase = "hash" | "pixel";
export type ScanProgress = { phase: ScanPhase; processed: number; total: number };

export type SkippedFile = { path: string; reason: string };

export type ScanResult = {
  images: ImageRecord[];
  /** path → File（プレビュー表示・2 パス目の再読込に使う）。 */
  fileByPath: Map<string, File>;
  /** デコード失敗などでレコードにできなかったファイル（SPEC §4 skippedFiles）。 */
  skipped: SkippedFile[];
};

/// items を最大 limit 本の runner で処理する。狙いは**同時実行制限ではなくメモリ**:
/// 各 runner は 1 件ずつ `file.arrayBuffer()` を読んで worker へ渡すので、全ファイルのバイトを
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

/// path キーを作る。フォルダ選択は webkitRelativePath（一意）。ドロップの loose File は名前が
/// 衝突し得るので、既存キーがあれば連番を付けて**取りこぼさない**（Map 上書きで静默脱落するのを防ぐ）。
function uniquePath(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = 2;
  let key = `${stem} (${n})${ext}`;
  while (used.has(key)) key = `${stem} (${++n})${ext}`;
  return key;
}

/// フォルダ選択/ドロップのファイル群を索引する（SPEC §2 パイプライン）。
/// 1 パス目: 全画像を sha256 + dHash。2 パス目: dHash 衝突バケット（メンバ≥2）のみ再デコードして
/// pixelSha256（SPEC §2.1）。クラスタリング（cluster_group）は呼び出し側が strictness に応じて行う。
export async function runScan(
  files: File[],
  pool: HashPool,
  poolSize: number,
  onProgress: (p: ScanProgress) => void,
): Promise<ScanResult> {
  const fileByPath = new Map<string, File>();
  const used = new Set<string>();
  for (const f of files) {
    if (!isImageFile(f.name)) continue;
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    const base = rel && rel.length > 0 ? rel : f.name;
    const key = uniquePath(base, used);
    used.add(key);
    fileByPath.set(key, f);
  }
  const paths = [...fileByPath.keys()];

  // 1 パス目: sha256 + dHash。
  let done1 = 0;
  onProgress({ phase: "hash", processed: 0, total: paths.length });
  const hashed = await runBounded(paths, poolSize, async (path) => {
    const bytes = await fileByPath.get(path)!.arrayBuffer();
    const res = (await pool.submit({ op: "hash", path, bytes }, [bytes])) as HashResult;
    onProgress({ phase: "hash", processed: ++done1, total: paths.length });
    return res;
  });

  const skipped: SkippedFile[] = hashed
    .filter((r) => r.error || r.phash === null)
    .map((r) => ({ path: r.path, reason: r.error ?? "デコードに失敗しました" }));

  const records: ImageRecord[] = hashed
    .filter((r) => !r.error && r.phash !== null)
    .map((r) => ({
      path: r.path,
      bytes: r.bytes,
      width: r.width,
      height: r.height,
      format: FORMAT_ALIAS[extOf(r.path)] ?? extOf(r.path),
      sha256: r.sha256,
      pixelSha256: null,
      phash: r.phash,
    }));
  const recordByPath = new Map(records.map((rec) => [rec.path, rec]));

  // 2 パス目: dHash 衝突バケット（メンバ≥2）のメンバだけ pixelSha256 を算出（SPEC §2.1）。
  const byHash = new Map<string, string[]>();
  for (const rec of records) {
    const list = byHash.get(rec.phash!);
    if (list) list.push(rec.path);
    else byHash.set(rec.phash!, [rec.path]);
  }
  const candidates = [...byHash.values()].filter((m) => m.length >= 2).flat();

  if (candidates.length > 0) {
    let done2 = 0;
    onProgress({ phase: "pixel", processed: 0, total: candidates.length });
    await runBounded(candidates, poolSize, async (path) => {
      const bytes = await fileByPath.get(path)!.arrayBuffer();
      const res = (await pool.submit({ op: "pixel", path, bytes }, [bytes])) as PixelResult;
      const rec = recordByPath.get(path);
      if (rec) rec.pixelSha256 = res.pixelSha256;
      onProgress({ phase: "pixel", processed: ++done2, total: candidates.length });
    });
  }

  // 出力の決定性（SPEC §4）: images は path 昇順。
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { images: records, fileByPath, skipped };
}
