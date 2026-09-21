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
  | { op: "hash" | "pixel" | "decode"; path: string; bytes: ArrayBuffer }
  // **convert 系は `Blob` を渡す。** `Blob` は構造化複製で**参照ごと**運ばれるので、
  // 主線程はファイルを 1 バイトも読まずに済む（読むのは実際に要るワーカー側）。
  // 48MP の png は 1 回の読みで 100MB を超えるうえ、設定を触るたびに読み直すので、
  // 主線程で読むと滑動の手応えごと落ちる。
  | { op: "info"; path: string; blob: Blob }
  | { op: "convert"; path: string; blob: Blob; options: ConvertOptions; srcFormat: string }
  | { op: "warm" };

/**
 * **デコード済み画素が要る scan / compare 系のリクエスト**（`hash` / `pixel` / `decode`）。
 * こちらは `ArrayBuffer` を transfer で渡す —— 呼び出し側が既に読んでいるので
 * （scan は数千枚を有界並列で読み進める）、参照渡しの利点が無い。
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
