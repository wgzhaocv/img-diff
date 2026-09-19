import type { ConvertOptions } from "schema";

// ワーカー ⇄ メイン のメッセージ契約（DESIGN §4・web 内部プロトコル。索引レコードの型 ImageRecord は
// 共有契約 `schema` 側が正本なのでそちらを import する）。
// op="hash": 1 パス目（sha256 + dHash）。op="pixel": 2 パス目（pixelSha256・dHash 衝突バケットのみ）。
// op="decode": compare（2 枚比較）用。sha256 + dHash に加え、白平坦化後の全分解能 RGBA を返す
//   （呼び出し側が compare_scores / diff_highlight に使う）。scan の hash/pixel とは別経路。

// op="convert": 寸法・形式の変換（SPEC §5.4）。scan/compare とは別経路で、
//   デコード結果ではなく**符号化済みのバイト列**を返す。
export type WorkerRequest =
  | { op: "hash" | "pixel" | "decode"; path: string; bytes: ArrayBuffer }
  | { op: "convert"; path: string; bytes: ArrayBuffer; options: ConvertOptions; srcFormat: string };

export type HashResult = {
  op: "hash";
  path: string;
  /** ファイル内容の SHA-256（16進）。 */
  sha256: string;
  /** dHash（16進16文字）。デコード失敗時は null。 */
  phash: string | null;
  width: number;
  height: number;
  bytes: number;
  /** ~256px の webp サムネ（DESIGN §6）。失敗時は無し。非 SAB（Blob 化のため）。 */
  thumb?: Uint8Array<ArrayBuffer>;
  error?: string;
};

export type PixelResult = {
  op: "pixel";
  path: string;
  /** 白平坦化後 RGBA の SHA-256（16進）。失敗時 null。 */
  pixelSha256: string | null;
  error?: string;
};

export type DecodeResult = {
  op: "decode";
  path: string;
  /** ファイル内容の SHA-256（16進）。 */
  sha256: string;
  /** dHash（16進16文字）。デコード失敗時は null。 */
  phash: string | null;
  width: number;
  height: number;
  bytes: number;
  /** 白平坦化後の全分解能 RGBA（compare_scores / diff_highlight 用）。失敗時は無し。非 SAB。 */
  rgba?: Uint8Array<ArrayBuffer>;
  /** ~256px の webp サムネ（プレビュー用）。失敗時は無し。非 SAB。 */
  thumb?: Uint8Array<ArrayBuffer>;
  error?: string;
};

export type ConvertResult = {
  op: "convert";
  path: string;
  /** 変換後のバイト列。失敗時は無し。非 SAB（Blob 化・transfer のため）。 */
  out?: Uint8Array<ArrayBuffer>;
  /** 実際に書き出した形式（正規化後）。失敗時は空文字。 */
  format: string;
  width: number;
  height: number;
  error?: string;
};

export type WorkerResponse = HashResult | PixelResult | DecodeResult | ConvertResult;
