import type { ImageRecord } from "schema";
import type { HashResult, PixelResult } from "@/lib/hashTypes";
import { HashPool } from "@/lib/workerPool";
import { gcOrphans, getRootHashes, HASH_ALGO, putHash, putThumb, type HashEntry } from "@/lib/db";
import { webpBlob } from "@/lib/convertControls";
import { resolveRoot, walkImages } from "@/lib/fsaccess";
import { compareCodepoint, dirOf, extOf, isScannableImage, uniquePath } from "@/lib/imagePaths";

// CLI `util.rs::normalize_ext` と揃える（producer 間で ImageRecord.format を一致させる）。
const FORMAT_ALIAS: Record<string, string> = { jpg: "jpeg", tif: "tiff" };

/// 名前/パスの拡張子を CLI `util.rs::normalize_ext` と揃えた format 名にする（jpg→jpeg 等）。
/// worker は libvips のローダ名を返さないため、両端で ImageRecord.format を一致させる近似として使う。
export function normalizeFormat(path: string): string {
  const ext = extOf(path);
  return FORMAT_ALIAS[ext] ?? ext;
}

// path 昇順（決定性・SPEC §4）。比較子は共有（localeCompare を使わない規則を 1 箇所に）。
const byPath = (a: { path: string }, b: { path: string }): number =>
  compareCodepoint(a.path, b.path);

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

/**
 * その path が「最後まで読めなかったフォルダ」の下に在るか。**掃除の対象から外すために使う。**
 *
 * 祖先を根まで辿る（文字列の前方一致ではなく**フォルダ単位**で見るので、`a/b` が `a/bb` を
 * 巻き込むことが無い）。根の失敗は `""` なので、そのときは必ず最後に当たる。
 */
export function underUnreadable(path: string, unreadable: Set<string>): boolean {
  if (unreadable.size === 0) return false;
  for (let dir = dirOf(path); ; dir = dirOf(dir)) {
    if (unreadable.has(dir)) return true;
    if (dir === "") return false;
  }
}

/// items を最大 limit 本の runner で処理する。狙いは**同時実行制限ではなくメモリ**:
/// 各 runner は 1 件ずつ読み込むので、全ファイルのバイトを一度に持たない
/// （ワーカーの同時実行は HashPool 側が絞る。limit=poolSize で歩調を合わせる）。
export async function runBounded<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  // **この呼び出しだけの旗。** `secondPassPixels` は 2 つの呼び出し元が通る共有 seam なので、
  // モジュール変数にすると別の実行を巻き込む。
  let failed = false;
  let firstError: unknown;
  async function worker(): Promise<void> {
    try {
      while (next < items.length && !failed) {
        const i = next++;
        await task(items[i], i);
      }
    } catch (e) {
      // **最初の失敗で新規の取り出しを止める。** 止めないと、呼び出し側が既に諦めた後も
      // 残りの runner が残り全件を読み込み続ける（1 件ごとに `arrayBuffer()` を払って捨てる）。
      // ここでは投げ直さず記録だけする —— 投げると `Promise.all` がそこで返ってしまい、
      // 下の「全員が降りるまで待つ」が成り立たない。
      if (!failed) {
        failed = true;
        firstError = e;
      }
    }
  }
  // **全員が降りるまで待ってから投げる。** ここが「この呼び出しの仕事は終わった」という境界で、
  // 境界が無いと、呼び出し側が失敗を受けて次のスキャンを始めた後に、前のスキャンの runner が
  // 進捗を書いたり `putHash` を完了したりし得る（並列上限も一時的に超える）。
  // 旗を見るのは次を取る所なので、待つのは走行中の最大 `limit - 1` 件だけ。
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw firstError;
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
    if (!isScannableImage(f.name)) continue;
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
  const { files, unreadableDirs } = await walkImages(dirHandle, isScannableImage);
  const cached = await getRootHashes(root.rootId);

  // GC: 列挙に無くなった path（OS 側で削除/移動）のキャッシュを掃除して stale を残さない（DESIGN §5）。
  // present は「開けたか」ではなく「列挙に在ったか」で見る（getFile 失敗の既存ファイルを誤って GC しない）。
  //
  // **確かめられていないフォルダの下は消さない。** 読めなかっただけのフォルダを「無くなった」と
  // 読むと、次に読めたときに hash もサムネも作り直しになる（読める兄弟が 1 つ在れば起きていた）。
  // 根ごと読めなければ `""` が入るので全部が守られる ＝ 以前の「空列挙なら GC しない」安全ガードを、
  // フォルダの粒度へ置き換えた形。**逆に、祖先が全部読めていれば消えた物は消えたと言える**
  // （フォルダごと消された場合もここで掃除される）。
  const present = new Set(files.map((f) => f.path));
  await gcOrphans(
    root.rootId,
    [...cached.keys()].filter((p) => !present.has(p) && !underUnreadable(p, unreadableDirs)),
  );

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
