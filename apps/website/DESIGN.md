# web 版設計（apps/website）

web 版のパイプライン・永続化・堅牢性（中断再開）の設計メモ。
ロジックの正本は `packages/schema/SPEC.md`、本書は **web 固有の実装設計**（ワーカー構成・
IndexedDB・権限の扱い）を定める。**キャッシュやストレージは「共有契約」ではなく
プラットフォーム固有 I/O** なので SPEC には載せない。SPEC が保証するのは「両端で同じ
ハッシュ値が出ること」だけ（§1）。CLI 側は SQLite で同じ概念を別実装する。

## 0. 前提・制約

- 純クライアント（サーバなし）、Cloudflare 静的ホスティングへデプロイ。
- ハッシュ／類似判定ロジックは `crates/wasm`（= `crates/core` の wasm ビルド）。
- デコード・前処理（SPEC §1 手順 1〜4）は **wasm-vips**。core は RGBA を受けて §1 手順 5〜8 を行う。
- `SharedArrayBuffer` を使うため **COOP/COEP ヘッダ必須** → `apps/website/public/_headers` を用意する（未作成）。
  ```
  /*
    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp
  ```
- ディレクトリスキャンは **File System Access API（Chromium 限定）**。非対応ブラウザと
  「権限なし」状態のフォールバックは §6。

## 1. レイヤ構成

```
┌─ UI 層（React）            … 進捗・グループ表示・再開ボタン・削除操作
├─ オーケストレータ（main）   … ジョブ管理・ワーカー割り当て・IndexedDB 書き込み・クラスタリング
├─ ワーカープール（N 本）     … 各自 wasm-vips + crates/wasm を保持し デコード+ハッシュ
└─ IndexedDB                 … 永続ストア（jobs / roots / hashes / thumbs）
```

- **重い処理（デコード+ハッシュ）は必ずワーカーで**。メインスレッドはオーケストレーションと UI のみ。
- クラスタリング（SPEC §5）はハッシュさえ揃えばメモリ内で一瞬 → **永続化しない**。
  再開時はキャッシュ済みハッシュから再計算する。

## 2. パイプライン（scan）

```
1. ディレクトリ選択（showDirectoryPicker）→ rootId を割り当て / 既存と isSameEntry で照合
2. 列挙（再帰）        → 対象ファイル一覧
3. キャッシュ突合      → 「やること = 列挙 − キャッシュ済（path+size+mtime+hashAlgo 一致）」
4. ハッシュ（ワーカー） → 1 件ごとに IndexedDB へ逐次コミット（= 進捗ログ）
5. クラスタリング      → キャッシュ済ハッシュ全体から SPEC §5 を再計算
6. レポート表示        → groups / stats / reclaimableBytes（SPEC §4）
```

「やること = 列挙 − キャッシュ済」という一行が、**速度（再スキャン高速化）と
堅牢性（中断再開）を同時に成立させる中核**。両者は同じ仕組み。

## 3. IndexedDB スキーマ

| ストア   | keyPath          | 主なフィールド                                                                            | 役割                                               |
| -------- | ---------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `roots`  | `rootId`         | `dirHandle`(構造化複製), `name`                                                           | フォルダの永続ハンドルと安定 ID                    |
| `jobs`   | `jobId`          | `rootId`, `params`, `status`, `discovered`, `processed`, `createdAt`, `updatedAt`         | スキャン 1 回分の状態                              |
| `hashes` | `[rootId, path]` | `size`, `mtime`, `hashAlgo`, `sha256`, `pixelSha256`, `dHash`, `width`, `height`, `bytes` | 各画像のハッシュ（= 進捗・キャッシュ・再開の正本） |
| `thumbs` | `[rootId, path]` | `blob`(~256px)                                                                            | プレビュー用サムネ（§6 で詳述、遅延ロード）        |

- `hashes` は **`jobId` ではなく `rootId` で持つ** → 別日の再スキャン（別ジョブ）でも再利用できる。
  `jobs` は「1 回の実行」、`hashes` は「フォルダに紐づく長命キャッシュ」と分離する。
- `status`: `"enumerating" | "hashing" | "clustering" | "done" | "interrupted"`。
- `thumbs` を `hashes` と別ストアにするのは、グループ一覧の描画時に blob を引かず
  メタだけ読めるようにするため（仮想スクロールで遅延ロード）。

### 3.1 キャッシュキーと無効化（CLI と論理一致）

- キー = `(rootId, path)`、無効化条件 = `size` か `mtime` か `hashAlgo` が変化。
- `File.size` / `File.lastModified` を使う（czkawka の size+mtime と同方式、`reference/czkawka` 参照）。
- `hashAlgo`（= SPEC §6 `HASH_ALGO_VERSION`）が上がれば該当レコードは miss 扱いで再計算。
- CLI 側 SQLite と **同じキー論理**で揃える（保存形式だけ違う）。

## 4. ワーカープール

- 本数 `N = min(navigator.hardwareConcurrency, 8)` 程度。
- 各ワーカーは起動時に **wasm-vips と crates/wasm を 1 度だけ初期化**して使い回す。
- **二重並列に注意**: vips 内部スレッド × N ワーカーは過剰購読になる。
  原則「**シングルスレッド vips × N ワーカー**」で単純化する。
- メッセージ契約（案）:
  - req: `{ id, fileHandle, path, params: { hashAlgo, needPixelSha, thumbSize } }`
    - `FileSystemFileHandle` はワーカーへ postMessage 可能 → ワーカー内で `getFile()` して
      バイト取得（メインスレッドでバイトを読まない）。
  - res: `{ id, path, size, mtime, sha256, pixelSha256, dHash, width, height, bytes, thumb?, error? }`
- `sha256` は **ファイルバイトを `crypto.subtle.digest` で直接ハッシュ**（デコード不要）。

## 5. 堅牢性（中断再開）

「ページを閉じた / PC が落ちた → 再度開いて続行」を成立させる要件。

1. **逐次コミット**: 1 件（または ~50 件の小バッチ）ごとに `hashes` へコミット。
   **全件を 1 トランザクションに包まない**（完了までフラッシュされず、落ちると全消失）。
   デコードが高コストなのでコミット頻度のオーバーヘッドは誤差。
2. **ディレクトリハンドル永続化**: `FileSystemDirectoryHandle` は構造化複製可 →
   `roots` に保存し、再開時に取り出す（フォルダ再選択を不要にする）。
3. **ジョブ記録**: `jobs` に未完了（`status != "done"`）があれば、起動時に
   「前回の未完了スキャンを再開しますか？」を提示。
4. **永続ストレージ要求**: 既定の IndexedDB はディスク逼迫で **退避され得る** →
   `navigator.storage.persist()` を呼んで常駐要求。
5. **中断中のレコード**: デコード途中で落ちた 1 件は **トランザクション未コミット** →
   再開時 miss 扱いで再処理。IndexedDB はトランザクション原子性があり**半端なレコードは残らない**。
6. **クラスタリングは非永続**: ハッシュが揃ってから再計算するだけ。中間状態は持たない。

### 再開フロー

```
起動 → jobs に interrupted あり → [続行] ボタン提示
  → requestPermission（ユーザー操作必須・§6）
  → 列挙 − キャッシュ突合 → 残りだけハッシュ → クラスタリング → レポート
```

## 6. 権限と劣化動作（ユーザーが授権しない場合）

### 権限が要るもの / 要らないもの

| やること                                 | フォルダ権限                                             |
| ---------------------------------------- | -------------------------------------------------------- |
| **完了済み結果の表示**（groups / stats） | **不要**（ハッシュは自 origin のデータ）                 |
| 未完了分の **続行**                      | 要（未処理ファイルを読む）                               |
| 原画の **プレビュー**                    | 要（再読み込み）… ただしサムネをキャッシュしていれば不要 |
| 重複の **削除**                          | 要・かつ `readwrite`（より強い権限）                     |

→ **授権しない ≠ 全損**。算出済みの結果は読み取り専用で表示し続ける。エラーで落とさない。

### 劣化動作の方針

1. 再開時に再授権を拒否 → **キャッシュからレポートを読み取り専用表示**（「3000/5000 まで完了、現時点の重複組」）。
2. 「再授権」ボタンを置き、何が解放されるか明示（続行 / プレビュー / 削除）。`requestPermission` は
   **ユーザー操作（クリック）内でしか呼べない**＝静默自動再開は不可能（ブラウザのセキュリティ制約）。
3. **権限は段階要求**: スキャンは `read` のみ。**削除の瞬間だけ** `readwrite` を別途要求。
   先に書き込み権限まで要求すると拒否率が上がる。SPEC §5 上 perceptual は自動削除不可なので、
   削除は常にユーザーの明示操作 → そのタイミングで `readwrite` を要求すればよい。

### サムネのキャッシュ（劣化状態を実用にする）

- デコードのついでに ~256px のサムネを生成し `thumbs` に保存。
- 以後 **フォルダ権限ゼロでもプレビュー表示可能** → レポートが自己完結する。
- コスト: 数千枚 × ~20KB ≈ 数十 MB。`navigator.storage.persist()` 前提で通常問題ないが、
  **上限設定 / オフ切り替えを用意**する（→ §8 未決）。

### 非対応ブラウザ / 権限なしのフォールバック

- `<input type="file" webkitdirectory>` またはドラッグ&ドロップ → `File` 配列を取得。
- **スキャンとレポートは可能**だが、永続ハンドルがない → **再開不可・原ファイル削除不可**。
- この 1 機構が「権限なしの兜底」と「Firefox/Safari の兜底」を**兼ねる**（FS Access は Chromium 限定）。

## 7. 性能レバー（いま決める / あとで計測してから）

**いま骨格に入れる（後付けが困難）**

- ワーカープール（§4）— 単線程で書くと後からワーカー化＝ほぼ書き直し。
- IndexedDB キャッシュ（§3）— 速度と再開の中核。

**あとで（profiler が要ると言ってから）**

- **shrink-on-load**: dHash は 9×8 で足りる → libvips/wasm-vips で JPEG を 1/8 デコード等、大幅短縮。
- **wasm SIMD**: SSIM / pixelDiff に効く。N² の popcount は元々誤差なので無関係。

## 8. 未決事項（要・合意）

- ~~pixelSha256 の遅延計算~~ **【解決済み】** SPEC §2.1 で「dHash が他と一致する候補のみ算出」に確定。
  web は全画像の dHash 計算後、衝突バケット（メンバ ≥2）のメンバだけ全分解能で再デコードして
  pixelSha256 を算出する第 2 パスを設ける（CLI と同一ロジック）。
- **サムネのストレージ上限ポリシー**（保存件数・総容量・オフ切替）。
- **複数タブ排他**: 同一フォルダを 2 タブで同時スキャン → 重複処理。
  `navigator.locks`（Web Locks API）でロック、または `jobs` に owner 印。優先度低・TODO。
- `roots` の rootId 安定化（再選択時の `isSameEntry` 照合）の具体実装。

## 9. 作成予定物（このメモ確定後）

- `apps/website/public/_headers`（COOP/COEP）
- React 化（現状は Vite バニラ TS テンプレート: `src/main.ts` / `counter.ts`）
- `src/` 配下: オーケストレータ / ワーカー / IndexedDB ラッパ / UI
