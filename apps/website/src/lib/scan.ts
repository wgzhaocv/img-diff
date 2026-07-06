import type { ImageRecord } from "schema";
import type { HashResult, PixelResult } from "@/lib/hashTypes";
import { HashPool } from "@/lib/workerPool";
import { gcOrphans, getRootHashes, HASH_ALGO, putHash, putThumb, type HashEntry } from "@/lib/db";
import { resolveRoot, walkImages } from "@/lib/fsaccess";

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

/// 名前/パスの拡張子を CLI `util.rs::normalize_ext` と揃えた format 名にする（jpg→jpeg 等）。
/// worker は libvips のローダ名を返さないため、両端で ImageRecord.format を一致させる近似として使う。
export function normalizeFormat(path: string): string {
  const ext = extOf(path);
  return FORMAT_ALIAS[ext] ?? ext;
}

// path 昇順（コードポイント比較＝Rust CLI と決定性を揃える。localeCompare は不可）。SPEC §4。
const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export type ScanPhase = "enumerating" | "hash" | "pixel";
export type ScanProgress = { phase: ScanPhase; processed: number; total: number };

export type SkippedFile = { path: string; reason: string };

export type ScanResult = {
  images: ImageRecord[];
  /** path → File（プレビュー表示・2 パス目の再読込に使う）。 */
  fileByPath: Map<string, File>;
  /** デコード失敗などでレコードにできなかったファイル（SPEC §4 skippedFiles）。 */
  skipped: SkippedFile[];
  /** FS Access 経由（キャッシュ有）のとき rootId。File[] フォールバックでは undefined。 */
  rootId?: string;
  /** File[] 経路のサムネ（path → webp Blob・メモリ保持）。FS Access は IDB thumbs から引く。 */
  thumbByPath?: Map<string, Blob>;
};

function webpBlob(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes], { type: "image/webp" });
}

function entryToRecord(e: HashEntry): ImageRecord {
  return {
    path: e.path,
    bytes: e.bytes,
    width: e.width,
    height: e.height,
    format: e.format,
    sha256: e.sha256,
    pixelSha256: e.pixelSha256,
    phash: e.phash,
  };
}

/// items を最大 limit 本の runner で処理する。狙いは**同時実行制限ではなくメモリ**:
/// 各 runner は 1 件ずつ読み込むので、全ファイルのバイトを一度に持たない
/// （ワーカーの同時実行は HashPool 側が絞る。limit=poolSize で歩調を合わせる）。
async function runBounded<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      await task(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/// 2 パス目（SPEC §2.1）。dHash 衝突バケット（メンバ≥2）のメンバのみ pixelSha256 を持つよう
/// **現在のバケット構成から presence を再導出**（<2 のメンバは pixelSha256=null に落とす。キャッシュの
/// 古い値を信用しない＝不変条件「ユニーク dHash ⇒ null」を守る）。未算出の候補だけ pool で算出する。
/// runScan（キャッシュ無）/ scanFolder（キャッシュ有）が同一実装を通る seam。
async function secondPassPixels(
  records: ImageRecord[],
  resolveBytes: (path: string) => Promise<ArrayBuffer>,
  pool: HashPool,
  poolSize: number,
  onProgress: (p: ScanProgress) => void,
  onComputed?: (rec: ImageRecord) => Promise<void>,
): Promise<void> {
  const recordByPath = new Map(records.map((r) => [r.path, r]));
  const byHash = new Map<string, ImageRecord[]>();
  for (const r of records) {
    const list = byHash.get(r.phash!);
    if (list) list.push(r);
    else byHash.set(r.phash!, [r]);
  }
  const candidates: string[] = [];
  for (const members of byHash.values()) {
    if (members.length < 2) {
      for (const r of members) r.pixelSha256 = null; // ユニークは pixelSha256 を持たない。
    } else {
      for (const r of members) if (r.pixelSha256 == null) candidates.push(r.path);
    }
  }
  if (candidates.length === 0) return;

  let done = 0;
  onProgress({ phase: "pixel", processed: 0, total: candidates.length });
  await runBounded(candidates, poolSize, async (path) => {
    const bytes = await resolveBytes(path);
    const res = (await pool.submit({ op: "pixel", path, bytes }, [bytes])) as PixelResult;
    const rec = recordByPath.get(path)!;
    rec.pixelSha256 = res.pixelSha256;
    await onComputed?.(rec);
    onProgress({ phase: "pixel", processed: ++done, total: candidates.length });
  });
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

/// ドロップ / フォールバック input の File[] を索引する（キャッシュ・再開なし・DESIGN §6）。
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

  const records: ImageRecord[] = [];
  const skipped: SkippedFile[] = [];
  const thumbByPath = new Map<string, Blob>();
  let done = 0;
  onProgress({ phase: "hash", processed: 0, total: paths.length });
  await runBounded(paths, poolSize, async (path) => {
    const bytes = await fileByPath.get(path)!.arrayBuffer();
    const res = (await pool.submit({ op: "hash", path, bytes }, [bytes])) as HashResult;
    onProgress({ phase: "hash", processed: ++done, total: paths.length });
    if (res.error || res.phash === null) {
      skipped.push({ path, reason: res.error ?? "デコードに失敗しました" });
      return;
    }
    if (res.thumb) thumbByPath.set(path, webpBlob(res.thumb));
    records.push({
      path,
      bytes: res.bytes,
      width: res.width,
      height: res.height,
      format: normalizeFormat(path),
      sha256: res.sha256,
      pixelSha256: null,
      phash: res.phash,
    });
  });

  await secondPassPixels(
    records,
    (p) => fileByPath.get(p)!.arrayBuffer(),
    pool,
    poolSize,
    onProgress,
  );

  records.sort(byPath);
  skipped.sort(byPath);
  return { images: records, fileByPath, skipped, thumbByPath };
}

/// フォルダ（永続ハンドル）を索引する。FS Access + IndexedDB キャッシュ版（DESIGN §2/§3/§5）。
/// 「やること = 列挙 − キャッシュ済（size+mtime+hashAlgo 一致）」で再スキャンを高速化し、1 件ごと
/// hashes へ逐次コミットして中断再開に備える。pixelSha256 もキャッシュから再利用する。
export async function scanFolder(
  dirHandle: FileSystemDirectoryHandle,
  pool: HashPool,
  poolSize: number,
  onProgress: (p: ScanProgress) => void,
): Promise<ScanResult> {
  const root = await resolveRoot(dirHandle);
  const files = await walkImages(dirHandle, isImageFile);
  const cached = await getRootHashes(root.rootId);

  // GC: 列挙に無くなった path（OS 側で削除/移動）のキャッシュを掃除して stale を残さない（DESIGN §5）。
  // present は「開けたか」ではなく「列挙に在ったか」で見る（getFile 失敗の既存ファイルを誤って GC しない）。
  // 空列挙（権限喪失や root ごと読めない等）は信用せず GC しない＝全キャッシュを消さない安全ガード。
  if (files.length > 0) {
    const present = new Set(files.map((f) => f.path));
    await gcOrphans(
      root.rootId,
      [...cached.keys()].filter((p) => !present.has(p)),
    );
  }

  const fileByPath = new Map<string, File>();
  const entryByPath = new Map<string, HashEntry>();
  const records: ImageRecord[] = [];
  const skipped: SkippedFile[] = [];
  const toHash: { path: string; file: File }[] = [];

  // 列挙 − キャッシュ突合（getFile を有界並列・1 件失敗は skip して継続）。
  let enumerated = 0;
  onProgress({ phase: "enumerating", processed: 0, total: files.length });
  await runBounded(files, poolSize, async ({ path, handle }) => {
    try {
      const file = await handle.getFile();
      fileByPath.set(path, file);
      const c = cached.get(path);
      if (c && c.size === file.size && c.mtime === file.lastModified && c.hashAlgo === HASH_ALGO) {
        entryByPath.set(path, c);
        records.push(entryToRecord(c));
      } else {
        toHash.push({ path, file });
      }
    } catch (e) {
      skipped.push({ path, reason: e instanceof Error ? e.message : "ファイルを開けませんでした" });
    } finally {
      onProgress({ phase: "enumerating", processed: ++enumerated, total: files.length });
    }
  });

  // やること（＝ミス分）だけハッシュ。成功分のみ hashes へ逐次コミット（失敗はキャッシュしない＝次回再試行）。
  let done1 = 0;
  onProgress({ phase: "hash", processed: 0, total: toHash.length });
  await runBounded(toHash, poolSize, async ({ path, file }) => {
    const bytes = await file.arrayBuffer();
    const res = (await pool.submit({ op: "hash", path, bytes }, [bytes])) as HashResult;
    onProgress({ phase: "hash", processed: ++done1, total: toHash.length });
    if (res.error || res.phash === null) {
      skipped.push({ path, reason: res.error ?? "デコードに失敗しました" });
      return;
    }
    const entry: HashEntry = {
      rootId: root.rootId,
      path,
      size: file.size,
      mtime: file.lastModified,
      hashAlgo: HASH_ALGO,
      sha256: res.sha256,
      pixelSha256: null,
      phash: res.phash,
      width: res.width,
      height: res.height,
      bytes: res.bytes,
      format: normalizeFormat(path),
    };
    await putHash(entry);
    entryByPath.set(path, entry);
    records.push(entryToRecord(entry));
    if (res.thumb) await putThumb({ rootId: root.rootId, path, blob: webpBlob(res.thumb) });
  });

  // 2 パス目（共通 seam）。算出した pixelSha256 はキャッシュ（HashEntry）へ read-modify-write で反映。
  await secondPassPixels(
    records,
    (p) => fileByPath.get(p)!.arrayBuffer(),
    pool,
    poolSize,
    onProgress,
    async (rec) => {
      const e = entryByPath.get(rec.path);
      if (e) {
        e.pixelSha256 = rec.pixelSha256;
        await putHash(e);
      }
    },
  );

  records.sort(byPath);
  skipped.sort(byPath);
  return { images: records, fileByPath, skipped, rootId: root.rootId };
}
