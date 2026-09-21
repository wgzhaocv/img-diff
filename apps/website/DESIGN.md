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

### 7.1 Phase 2 実装メモ・計測課題（レビューで判明）

- **pthread 過剰購読（要計測）**: 導入した wasm-vips 0.0.18 はスレッド版（SharedArrayBuffer 前提）。
  `vips.concurrency(1)` は演算スレッドを 1 にするが Emscripten の pthread プールは別レイヤ。
  N ワーカー × 各 vips の pthread で実スレッドが cores を超え得る（§4 の警告）。単一スレッド版が
  この配布に無いため、Phase 3 で数百〜数千枚を実測し、最適プール本数（min(cores,8) の妥当性）を決める。
- **メモリ（要計測）**: 各ワーカーが vips.wasm(5MB)+dyn libs を個別ロード → N 倍。将来 `WebAssembly.Module`
  をメインで 1 度コンパイルし postMessage で共有する余地（再コンパイル削減）。
- **shrink-on-load の橋渡し**: `workers/vips.ts::decodeCanonical` の `newFromBuffer(bytes, strOptions)` 第2引数
  or `thumbnailBuffer` に差し替えるだけで縮小デコードに移行可（core 側無改修）。**導入時は native==wasm の
  dHash 一致テスト（commit 30c482e）を必ず再実行**して一致を担保する。
- **pixelSha256 二次パス（Phase 3）**: 1 パス目は `flatten_and_dhash`（全分解能）で dHash のみ算出、ファイルバイトは
  transferable で worker へ譲渡済み。二次パスは衝突バケット（dHash 一致・メンバ≥2）のメンバだけ
  `file.arrayBuffer()` で**再読込**して pixelSha256 を算出する（File ハンドルは残るので再読可能）。

### 7.2 常時走るプレビュー（convert 画面）

**`/convert` が扱うのは 1 枚だけ**（SPEC §5.4「実装状況」）。設定を触るたびに**実際に変換して**
結果を見せ、**その結果が成果物そのもの**なので、この画面には「実行」が無い ——
`保存` を押すとブラウザの既定のダウンロード先へ落ちる（保存ダイアログもフォルダ選択も出さない）。

バッチを畳んだときに一緒に消えた物と、その理由:

| 消えた物                                                          | 在った理由                                              | 1 枚なら                   |
| ----------------------------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| 出力先（フォルダ / zip）と `ConvertSink`                          | N 件をどこかへ置く必要                                  | 既定の DL 先へ 1 ファイル  |
| `pickDirectory("readwrite")` と「入力フォルダの中へ書かない」判定 | 元データを壊さない番                                    | 書き込み権限を取らない     |
| `streamingZipSink`（背圧つき・195 行）と `client-zip`             | 全件をメモリに抱えない工夫                              | 1 枚なので要らない         |
| `findOutputCollisions`                                            | `a.jpg` と `a.png` が同じ `a.webp` になる（集合の性質） | 1 枚は自分と衝突しない     |
| `items` / `stats` / `ConvertReport` / 進捗                        | per-file の成否を集計                                   | 画面に出る 1 行で足りる    |
| サムネ網格・ページング・代表の選択                                | どれを見ているかを示す                                  | 1 枚しか無い               |
| `validate` / `previewSettled` / `formSettled`                     | 全件が駄目なときだけ止める判定と、その副作用の手当て    | 理由は `previewError` 1 つ |

入力より遅れないための決まりは 3 つ。破ると、スライダを掴んだだけで変換が積み上がる:

1. **入力が止まってから動かす** — 300ms の待ち（`ConvertPreview`）。
2. **同時に走るのは 1 枚だけ** — 走行中の要求は「最後の 1 回」だけ覚えて終わってからやり直す
   （`convertStore` の `previewBusy` / `previewQueued`）。
3. **原寸が届くまで動かさない** — `previewKey` は原寸を含み、原寸はサムネと一緒に**後から**届く。
   知らないまま始めると (a) 届いた瞬間に鍵が変わるので**同じ 1 枚を捨てるために符号化する**
   ことになり、(b)「大きすぎて書けない」判定（`writeBlockFor`）の入力が無いので、
   止めるはずの変換をプレビューだけが走らせる。実測（1024×1024 → avif・本番・冷起動）:
   4.2s → 8.5s。**答えを書かずに戻る唯一の枝**だが、戻る条件が解消すると鍵そのものが
   変わるので宙ぶらりんにはならない —— 成り立たせているのは「原寸は必ず記録される」という
   約束で、デコードできない画像もファイルが読めなかった画像も**原寸 0 で入る**（`loadInfo`）。
   それでも落ちたときのために、この枝は `loadInfo()` を催促してから戻る。

作り直す契機は `previewKey`（名前 + 原寸 + 解決済み `ConvertOptions`）で判定する。
`form` 全体を見張ると、出力に関係しない欄を触っただけで再変換が走る。

**保存できるのは「今の鍵の結果」だけ。** `保存` は `preview.key` が今の鍵と一致するときだけ出る
＝「見えている物を保存できる」。前の結果を新しい名前で落とせてしまわないよう、
リンクの `href` は絵とは**別の object URL** から張る（`useObjectUrl` は effect で URL を
張り替えるので、新しい結果が届いた最初の 1 フレームだけ食い違う）。

**作り直している間は前の絵を残す**（暗くする・`ConvertPreview` の `stale`）。avif は 1 枚に
数秒かかる（下表）ので、枠を空にすると固まったように見える。残すのは**絵だけ**で、
寸法・バイト数・保存ボタンは今の鍵の結果にしか従わない。
画像を選び直したときと、理由が出たとき（「書き出せません」の横に絵が在ると嘘になる）は残さない。

**形式ごとの実測**（1024×1024・設定変更から結果まで・300ms の待ちを含む・本番ビルド）:

| 出力 | png   | jpg   | webp  | jxl   | avif      |
| ---- | ----- | ----- | ----- | ----- | --------- |
| 実測 | 1.14s | 1.17s | 1.26s | 1.50s | **4.50s** |

**avif だけ桁が違うのは、wasm-vips の libaom が単線程で焼かれているため**
（上流 `build.sh` の `-DCONFIG_MULTITHREAD=0`「libvips のスレッドプールに任せる」——
だが libvips のスレッドプールは heifsave を並列化しない）。3277×3277 の同じ 1 枚で比べると
native libvips が 1 線程 8.58s / 8 線程 1.22s、wasm は 33s —— **wasm 自体の税は 3.8 倍しかなく、
残りは全部が線程**。`vips.concurrency(8)` を渡しても変わらない
（`vips-heif.wasm` に `pthread_create` が 1 つも無い）。

**自前ビルドで線程を入れる実験は、ブラウザで行き止まりだった（2026-09-21）。** 再挑戦する人のために:

- wasm-vips v0.0.18 を `-DCONFIG_MULTITHREAD=1`（aom）で焼き直すと、**node では狙いどおり速くなる** ——
  1024×1024 → avif が 3645ms（1 線程）→ **669ms**（8 線程）の 5.4 倍。出力も同等。
- ところが**同じ .wasm をブラウザの Web Worker で動かすと、`concurrency > 1` で確実に固まる**
  （CPU 0.5%・無言・2 / 4 / 8 いずれも）。リンク時に emscripten が
  `dynamic linking + pthreads is experimental` と警告する組み合わせ。
- 動的リンクを疑って `--disable-modules`（libheif/aom を `vips.wasm` に静的リンク・11.4MB 単体）でも
  焼いたが、**結果は同じ**。原因は動的リンクではなく、Worker の中から更に pthread を起こすことの方。
- **libvips 自身のスレッドは Worker の中でも動く**（同じビルド・`concurrency(8)` で png は 602ms で完走）。
  固まるのは aom の線程だけ。
- ビルド自体の落とし穴も 3 つある: libpng の `CPPFLAGS` に `-msimd128` が要る / closure compiler が
  Java 21 を要求する（emsdk 6.0.0 の image は 11）/ emsdk image の ENTRYPOINT が引数を食うので
  動作確認は `--entrypoint=""` で。

結論として、**avif が遅いのは受け入れる**。寸法の早押し（`PRESET_WIDTHS`）で縮めれば
実用域に収まるし、縮めるのは元々やりたいことでもある。

**入力のバイト列は主線程で読まない。** `ConvertSource` は `Blob` をそのまま持ち、
ワーカーへ `Blob` ごと渡す（構造化複製は Blob を**参照ごと**運ぶ）。読むのは実際に要る
ワーカー側（`op:"info"` / `op:"convert"`）。主線程で読むと、48MP の png で 1 回 100MB を
超える確保が**設定を触るたび**に走り、滑動の手応えごと落ちる。
素通し（SPEC §5.4 規則 4）は `file.slice()` で済むので**1 バイトも読まない**。
scan / compare 系（`hash` / `pixel` / `decode`）は呼び出し側が既に読んでいるので
`ArrayBuffer` を transfer したままにしてある。

**エンジンは画面を開いた時点で起こす。** wasm-vips は `getVips()` の遅延初期化なので、
何もしないと**最初の 1 件を処理しようとした瞬間**に約 11.9MB
（`vips.wasm` 5.08 + `vips-heif.wasm` 3.48 + `vips-jxl.wasm` 2.17 + `vips-resvg.wasm` 1.16MB）の
ダウンロードが始まる —— つまり利用者が画像を選び終えてから。実測（本番・冷起動）で
サムネが出るまで 2.5 秒。`ConvertScreen` の mount で `warmEngine()` を呼び、
画像を選んでいる間にこれを重ねる。

- **convert のプールは 1 本**（`poolRef(1)`）。この画面で同時に走る仕事は常に 1 つなので、
  本数を増やすと害だけが残る: `warmEngine` が温めるのは 1 本なのに `idle.pop()` が
  溢れた要求（原寸取得など）を**冷たいワーカー**へ配り、そこで wasm-vips をもう 1 つ
  起こしてしまう —— 実体ごとに 1GiB の線形メモリを予約する（§7.1）うえ、同時に始まるので
  HTTP キャッシュも効かず 11.9MB を二度落とし得る。1 本にすれば
  「温まった 1 本」が構造的に真になる。
- **`op:"warm"` は画像を渡さない空リクエスト**（`hashTypes.ts`）。単に `fetch` で HTTP
  キャッシュを温めるのでは足りない —— コンパイルと実体化が最初の 1 件に残る。
- **毎回投げてよい。** 二度目が無駄にならないのはワーカー側の `getVips()` が実体を記憶して
  いるから。`engine === "ready"` で早切りすると、画面を離れて戻ったときに
  `releaseIdlePools()` がプールを畳んでいても温かいと言い続けてしまう。
- 走っている間は `pool.hold()` を取る（キューは空で暇に見えるので、さもないと
  画面切替で温めている最中のプールが畳まれる）。
- **失敗は報せない。** 前倒しは利用者が頼んだ仕事ではないので、`engine` を `"cold"` へ
  戻すだけにする（本当の理由は実際に変換したときに同じ経路で出る）。
- **温めた実体は画面を離れてもすぐには捨てない。** `releaseIdlePools()` は画面切替ごとに
  呼ばれるので、即座に畳むと convert → scan → convert と戻るたびに wasm-vips を作り直す
  ことになる（バイトは HTTP キャッシュから来ても、コンパイルと 1GiB の予約は毎回払う）。
  `IDLE_GRACE_MS`（60 秒）使われていないものだけを畳み、猶予の内に在る物のために
  掃除を張り直す（さもないと「次の画面切替まで畳まれない」＝居座りになる）。

**「読み込み中」と「生成中」は画面で区別する**（UI.md §6）。出所は `engine` 1 つ。

原寸とサムネは専用の `op:"info"` で取る（`workers/vips.ts::applyInfo`）。
`decodeCanonical` を流用すると**全分解能 RGBA** と dHash を作ることになり、
実測 4000×3000 で 165ms / 45.8MB。`thumbnailBuffer` の shrink-on-load なら 53ms・その確保なし
（出力 webp は同一）。

### 7.3 補助デコーダ（HEVC の HEIC）

wasm-vips 0.0.18 の libheif は **HEVC を持たない**（AVIF は読める）ので、
HEIC だけ `libheif-js`（libde265 入り）で RGBA へ解いてから wasm-vips に渡す
（`workers/heic.ts`）。SPEC §1「デコーダは両端で別物である」の具体がこれ。

- **HEIC が実際に来るまで取りに行かない。** グルー（91KB）は bundle、wasm（1.4MB）は
  `public/libheif/` から。転送は gzip 0.48MB。実測: HEIC を含まない選択では取得 0 件。
- 復号は 300×500 で 13ms。
- **原生 libvips との差（実測）**: 画素は 29.9% のバイトが異なり最大差 11、SSIM 0.99753。
  **dHash は一致**（hamming 0）—— 9×8 への縮小で補間差がならされる。
  `scripts/check-heic-parity.sh` がこれを検査する。
- **decoder は使い回し、`free()` を必ず呼ぶ。** libheif-js は「同じ decoder の次の decode()」で
  しか前回の context を解放しない。実測: 4.5KB の夹具 ×3000 回で 16.3 → 48.6MB、
  使い回し + `free()` で 0。wasm のヒープは縮まない。
- `applyConvert` / `applyInfo` を**同期のまま**保つため、入力は `DecodeSource`
  （`encoded` か `rgba`）で受ける。非同期なのは入口（`toSource`）だけ。
- **向きの適用は libheif が済ませている**ので、RGBA 経路で `autorot` を重ねない（SPEC §1 手順 2）。
- **RGBA は vips へ往復させない**。libheif が返す物と `newFromMemory → writeToMemory` の
  結果は sha256 が一致するので、12MP で約 146MB ぶん無駄になる。
- 読めても**書けるようにはならない**。何を書けるかは `saveSpec` が唯一の正本（書けない形式には
  `null` を返す）で、画面の選択肢も検証もそこから導く。

### 7.4 大きい画像と保存器の制約（実測）

**libvips は流式に処理する**が、**保存器が全画素をメモリに要求する形式がある**。
6000×8000（48MP）の実測:

| 出力 | 既定(random)                                 | `access=sequential`    |
| ---- | -------------------------------------------- | ---------------------- |
| jpg  | OK 21.0MB / 1020ms                           | OK 21.0MB / **723ms**  |
| png  | OK 91.4MB / 2041ms                           | OK 91.4MB / **1757ms** |
| webp | **FAIL**（`out of memory -- size == 137MB`） | **FAIL**               |

jpg / png は逐行で書けるので通る。webp が落ちるのは **libwebp の API が `WebPPicture` に
全画素を要求する**ため（avif / gif / jxl も同類）。1920 へ縮小してからなら webp は通る
（1.2MB / 1008ms）。

対応:

- 読み込みは **`access=sequential`**（上の実測ぶん速い）。ただし `bg=average` は
  「統計 → 合成」で二度読みするので、その組み合わせだけ既定で読む。
- 予測できる失敗は**押す前に**止める（`tooLargeForFormat`。境は実測から 16MP）。
  wasm の例外は読めないし、大きい画像では数秒待たせてから落ちる。

### 7.5 プール本数の実測（§4 の既定の根拠・バッチ時代の計測）

**この表は convert がバッチだった頃の実測**（`stats.elapsedMs` ごと撤去済み）。
今 N 並列で回るのは scan だけなので、**既定本数の根拠としては scan で測り直すのが正しい**。
残してあるのは「外層の並列が効く」ことの記録として。24 枚（2000×1500）を 800×600 へ
変換したときの値:

| pool | 1     | 2     | 4     | 8         |
| ---- | ----- | ----- | ----- | --------- |
| 実測 | 713ms | 406ms | 244ms | **164ms** |

**外層の並列は効いている**（8 本で 4.35 倍）。本数を減らす理由は速度には無い。
一方でメモリは実体ごとに積み上がるので、**画面を離れたら畳む**（`releaseIdlePools`。
走行中のプールは畳まない）。計測用に `?pool=N` で上書きできる。

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
