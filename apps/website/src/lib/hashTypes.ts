import type { ConvertOptions } from "schema";

// ワーカー ⇄ メイン のメッセージ契約（DESIGN §4・web 内部プロトコル。索引レコードの型 ImageRecord は
// 共有契約 `schema` 側が正本なのでそちらを import する）。
// op="hash": 1 パス目（sha256 + dHash）。op="pixel": 2 パス目（pixelSha256・dHash 衝突バケットのみ）。
// op="decode": compare（2 枚比較）用。sha256 + dHash に加え、白平坦化後の全分解能 RGBA を返す
//   （呼び出し側が compare_scores / diff_highlight に使う）。scan の hash/pixel とは別経路。

// op="convert": 寸法・形式の変換（SPEC §5.4）。scan/compare とは別経路で、
//   デコード結果ではなく**符号化済みのバイト列**を返す。
// op="info": 見せるためだけの情報（原寸 + サムネ）。ハッシュも全分解能 RGBA も作らない
//   （convert 画面の入力一覧。数千枚を並べるので hash 経路だと重すぎる）。
// op="warm": **画像を渡さずに wasm-vips だけ起こす**。約 11.9MB のダウンロードとコンパイルを
//   利用者が画像を選んでいる間に済ませてしまうための空リクエスト（DESIGN §7.2）。
export type WorkerRequest =
  | { op: "hash" | "pixel" | "decode" | "info"; path: string; bytes: ArrayBuffer }
  | { op: "convert"; path: string; bytes: ArrayBuffer; options: ConvertOptions; srcFormat: string }
  | { op: "warm" };

/**
 * **画像を 1 枚抱えているリクエスト。** `warm` を足したことで `WorkerRequest` 全体には
 * `path` / `bytes` が無くなったので、1 枚を処理する関数はこちらを受ける
 * （union 全体を受けて中で絞り直すより、受け取る形で言い切る方が読める）。
 */
export type ImageRequest = Extract<WorkerRequest, { bytes: ArrayBuffer }>;

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

export type InfoResult = {
  op: "info";
  path: string;
  /** 原寸（EXIF の向き適用後）。デコードできなければ 0。 */
  width: number;
  height: number;
  /** ファイルのバイト数。 */
  bytes: number;
  /** ~256px の webp サムネ。デコードできなければ無し。非 SAB。 */
  thumb?: Uint8Array<ArrayBuffer>;
  error?: string;
};

export type ConvertResult = {
  op: "convert";
  path: string;
  /** 変換後のバイト列。失敗時は無し。非 SAB（Blob 化・transfer のため）。 */
  out?: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  /** libvips の版（`ConvertReport.producer.vips`）。失敗時は無し。 */
  vipsVersion?: string;
  /**
   * 再符号化せず元のバイト列をそのまま返した（SPEC §5.4 規則 4）。
   * 寸法を指定していても、その画像には効かない（拡大要求など）とここが true になる。
   */
  passedThrough?: boolean;
  error?: string;
};

/** `op:"warm"` の応答。**起きたことしか伝えない**（失敗は `error` に入れる）。 */
export type WarmResult = {
  op: "warm";
  error?: string;
};

export type WorkerResponse =
  | HashResult
  | PixelResult
  | DecodeResult
  | InfoResult
  | ConvertResult
  | WarmResult;
