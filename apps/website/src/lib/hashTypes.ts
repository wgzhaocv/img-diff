// ワーカー ⇄ メイン のメッセージ契約（DESIGN §4）。Phase 2 は 1 パス目
// （デコード + sha256 + dHash）のみ。pixelSha256 の二次パスは Phase 3。

export type HashRequest = {
  id: number;
  /** ルート相対パス（表示・キャッシュキー用）。 */
  path: string;
  /** ファイルバイト（postMessage の transferable として渡す）。 */
  bytes: ArrayBuffer;
};

export type HashResponse = {
  id: number;
  path: string;
  /** ファイル内容の SHA-256（16進）。 */
  sha256: string;
  /** dHash（16進16文字）。デコード失敗時は null。 */
  phash: string | null;
  width: number;
  height: number;
  /** バイト数。 */
  bytes: number;
  /** デコード等の失敗理由（成功時は無し）。 */
  error?: string;
};
