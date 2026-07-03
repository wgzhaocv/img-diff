import { openDB, type DBSchema, type IDBPDatabase } from "idb";

// IndexedDB 永続ストア（DESIGN §3）。roots=フォルダの永続ハンドル、jobs=1 回の実行状態、
// hashes=フォルダに紐づく長命キャッシュ（＝進捗・キャッシュ・再開の正本）、thumbs=プレビュー用サムネ。
// キャッシュやストレージは「共有契約」ではなくプラットフォーム固有 I/O なので SPEC には載せない。

/// SPEC §6 HASH_ALGO_VERSION。計算手順が変わったら上げ、該当キャッシュを miss 扱いにする。
export const HASH_ALGO = "dhash-1";

export type HashEntry = {
  rootId: string;
  /** ルートからの相対パス（'/' 区切り）。 */
  path: string;
  /** キャッシュ無効化キー（size/mtime/hashAlgo のいずれか変化で再計算）。 */
  size: number;
  mtime: number;
  hashAlgo: string;
  sha256: string;
  pixelSha256: string | null;
  phash: string | null;
  width: number;
  height: number;
  bytes: number;
  format: string;
};

export type RootEntry = {
  rootId: string;
  dirHandle: FileSystemDirectoryHandle;
  name: string;
};

export type JobStatus = "enumerating" | "hashing" | "clustering" | "done" | "interrupted";
export type JobEntry = {
  jobId: string;
  rootId: string;
  status: JobStatus;
  discovered: number;
  processed: number;
  createdAt: number;
  updatedAt: number;
};

export type ThumbEntry = { rootId: string; path: string; blob: Blob };

interface ImgDiffDB extends DBSchema {
  roots: { key: string; value: RootEntry };
  jobs: { key: string; value: JobEntry; indexes: { "by-root": string } };
  hashes: { key: [string, string]; value: HashEntry; indexes: { "by-root": string } };
  thumbs: { key: [string, string]; value: ThumbEntry };
}

let dbPromise: Promise<IDBPDatabase<ImgDiffDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<ImgDiffDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ImgDiffDB>("imgdiff", 1, {
      upgrade(db) {
        db.createObjectStore("roots", { keyPath: "rootId" });
        db.createObjectStore("jobs", { keyPath: "jobId" }).createIndex("by-root", "rootId");
        db.createObjectStore("hashes", { keyPath: ["rootId", "path"] }).createIndex(
          "by-root",
          "rootId",
        );
        db.createObjectStore("thumbs", { keyPath: ["rootId", "path"] });
      },
    });
  }
  return dbPromise;
}

/// IndexedDB が退避されないよう常駐要求（DESIGN §5.4）。失敗は致命でない。
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    // 権限が得られなくても続行（キャッシュは best-effort）。
  }
}

export async function getRoots(): Promise<RootEntry[]> {
  return (await getDB()).getAll("roots");
}

export async function putRoot(entry: RootEntry): Promise<void> {
  await (await getDB()).put("roots", entry);
}

/// ルート配下の全キャッシュ済ハッシュを取得（path → HashEntry）。
export async function getRootHashes(rootId: string): Promise<Map<string, HashEntry>> {
  const db = await getDB();
  const entries = await db.getAllFromIndex("hashes", "by-root", rootId);
  return new Map(entries.map((e) => [e.path, e]));
}

/// ハッシュを 1 件コミット（逐次コミット＝進捗の永続化・DESIGN §5.1）。
export async function putHash(entry: HashEntry): Promise<void> {
  const db = await getDB();
  await db.put("hashes", entry);
}

/// キャッシュ済ハッシュを 1 件削除（実削除後の reconcile 用＝正本を消す）。
export async function deleteHash(rootId: string, path: string): Promise<void> {
  const db = await getDB();
  await db.delete("hashes", [rootId, path]);
}

export async function getThumb(rootId: string, path: string): Promise<Blob | undefined> {
  const db = await getDB();
  return (await db.get("thumbs", [rootId, path]))?.blob;
}

/// サムネは best-effort（表示補助であって正本でない）。quota 超過等で失敗してもスキャンは止めない
/// （putHash＝再開の正本は別 txn で先にコミット済み）。DESIGN §6/§8。
export async function putThumb(entry: ThumbEntry): Promise<void> {
  try {
    const db = await getDB();
    await db.put("thumbs", entry);
  } catch {
    // IDB quota 超過など。サムネは捨てて続行（表示は原 File にフォールバック）。
  }
}

/// サムネを 1 件削除（実削除後の reconcile 用）。サムネは正本でないので失敗は握り潰す（best-effort）。
export async function deleteThumb(rootId: string, path: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete("thumbs", [rootId, path]);
  } catch {
    // 消せなくても致命でない（次回スキャンの GC で整合）。
  }
}
