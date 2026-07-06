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

// requestPermission は lib.dom の型に無い（FS Access の権限 API）ので最小宣言。
type PermMode = { mode?: "read" | "readwrite" };
type WithPermission = FileSystemHandle & {
  requestPermission?: (opts?: PermMode) => Promise<PermissionState>;
};

export type EnumeratedFile = { path: string; handle: FileSystemFileHandle };

export function supportsFileSystemAccess(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

/// 書き込み権限を要求する（**ユーザー操作内=click で呼ぶ**・DESIGN §6.3 の段階要求）。
/// 許可されたら true。scan は read のみなので削除時にだけ readwrite へ昇格する
/// （既に許可済みなら requestPermission はプロンプトを出さずそのまま granted を返す）。
export async function requestWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as WithPermission;
  if (!h.requestPermission) return false;
  return (await h.requestPermission({ mode: "readwrite" })) === "granted";
}

/// 保存済みハンドルの read 権限を（**ユーザー操作内=click で**）再取得する。許可されたら true。
/// reload 後の永続ハンドルは権限 "prompt" 状態なので、前回フォルダの再スキャン前にこれで昇格する
/// （既に許可済みならプロンプト無しで granted）。DESIGN §5「再開フロー」/ §6.3。
export async function requestReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as WithPermission;
  if (!h.requestPermission) return false;
  return (await h.requestPermission({ mode: "read" })) === "granted";
}

/// root 相対パス（'/' 区切り）を辿り、親ディレクトリの removeEntry で 1 ファイルを削除する。
/// **破壊的操作なので防御的に**: 空・'.'・'..' を含むセグメントは想定外として throw（CLI clean.rs の
/// fail-closed に相当）。呼び出し側が readwrite 権限を取得済みである前提。
export async function removeByPath(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  // split は必ず 1 要素以上を返すので、空パスは空セグメント（""）として下の検査で弾かれる。
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`削除対象のパスが不正です: ${path}`);
  }
  let dir = root;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i]);
  }
  await dir.removeEntry(segments[segments.length - 1]);
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
