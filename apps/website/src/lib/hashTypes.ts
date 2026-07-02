// ワーカー ⇄ メイン のメッセージ契約（DESIGN §4・web 内部プロトコル。索引レコードの型 ImageRecord は
// 共有契約 `schema` 側が正本なのでそちらを import する）。
// op="hash": 1 パス目（sha256 + dHash）。op="pixel": 2 パス目（pixelSha256・dHash 衝突バケットのみ）。

export type WorkerRequest = { op: "hash" | "pixel"; path: string; bytes: ArrayBuffer };

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
  error?: string;
};

export type PixelResult = {
  op: "pixel";
  path: string;
  /** 白平坦化後 RGBA の SHA-256（16進）。失敗時 null。 */
  pixelSha256: string | null;
  error?: string;
};

export type WorkerResponse = HashResult | PixelResult;
