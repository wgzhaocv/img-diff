import { getRoots, putRoot, requestPersistentStorage, type RootEntry } from "@/lib/db";

// File System Access API（Chromium 限定）。フォルダの永続ハンドルで再スキャン高速化・中断再開を成立させる。
// 非対応ブラウザは呼び出し側が File[] フォールバックへ（DESIGN §6）。

// lib.dom に無い版があるため showDirectoryPicker を最小宣言。
declare global {
  interface Window {
    showDirectoryPicker?: (opts?: {
      mode?: "read" | "readwrite";
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export type EnumeratedFile = { path: string; handle: FileSystemFileHandle };

export function supportsFileSystemAccess(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

/// フォルダを選ばせて永続ハンドルを得る（**ユーザー操作内**で呼ぶ）。スキャンは read のみ。
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!window.showDirectoryPicker) return null;
  try {
    return await window.showDirectoryPicker({ mode: "read" });
  } catch (e) {
    // ユーザーがキャンセル（AbortError）した等は null。
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

/// dirHandle を roots に照合し、既存（isSameEntry）なら同じ rootId を返す。無ければ新規登録。
export async function resolveRoot(dirHandle: FileSystemDirectoryHandle): Promise<RootEntry> {
  for (const r of await getRoots()) {
    try {
      if (await r.dirHandle.isSameEntry(dirHandle)) {
        const updated: RootEntry = { ...r, dirHandle, name: dirHandle.name };
        await putRoot(updated); // 権限再取得後の新しい handle に更新。
        return updated;
      }
    } catch {
      // 壊れた/失効ハンドルはスキップ。
    }
  }
  const entry: RootEntry = { rootId: crypto.randomUUID(), dirHandle, name: dirHandle.name };
  await putRoot(entry);
  await requestPersistentStorage();
  return entry;
}

/// dirHandle 配下の画像ファイルを再帰列挙する（ルート相対パス + handle）。
/// アクセスできないサブディレクトリは握り潰してスキップし、全体は止めない（DESIGN §6・CLI と同方針）。
export async function walkImages(
  dir: FileSystemDirectoryHandle,
  isImage: (name: string) => boolean,
): Promise<EnumeratedFile[]> {
  const out: EnumeratedFile[] = [];
  async function recurse(handle: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    try {
      for await (const [name, child] of handle.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (child.kind === "file") {
          if (isImage(name)) out.push({ path, handle: child });
        } else {
          await recurse(child, path);
        }
      }
    } catch {
      // このディレクトリは列挙できないのでスキップ（権限/失効等）。
    }
  }
  await recurse(dir, "");
  return out;
}
