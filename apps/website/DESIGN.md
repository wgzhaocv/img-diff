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

### 7.2 常時走るプレビューと入力一覧（convert 画面）

`/convert` は設定を触るたびに**実際に 1 枚変換して**結果を見せる（UI.md §6.1）。
入力より遅れないための決まりは 3 つ。破ると、スライダを掴んだだけで変換が積み上がる:

1. **入力が止まってから動かす** — 300ms の待ち（`ConvertPreview`）。
2. **同時に走るのは 1 枚だけ** — 走行中の要求は「最後の 1 回」だけ覚えて終わってからやり直す
   （`convertStore` の `previewBusy` / `previewQueued`）。
3. **本番の変換中は動かさない** — 同じワーカープールを奪い合わない。
4. **原寸が届くまで動かさない** — `previewKey` は代表 1 枚の原寸を含み、原寸は
   サムネと一緒に**後から**届く。知らないまま始めると (a) 届いた瞬間に鍵が変わるので
   **同じ 1 枚を捨てるために符号化する**ことになり、(b)「大きすぎて書けない」判定
   （`writeBlockFor`）の入力が無いので、押す前に止めるはずの変換をプレビューだけが走らせる。
   実測（1024×1024 → avif・本番・冷起動）: 4.2s → 8.5s。

作り直す契機は `previewKey`（代表 1 枚 + その原寸 + 解決済み `ConvertOptions`）で判定する。
`form` 全体を見張ると、出力に関係しない欄（上書き）を触っただけで再変換が走る。

**保存の可否はこの仕組みに乗っている。** 保存ボタン（`ConvertDestination`）は
`previewSettled` が立つまで押せない＝「見ていない結果を書き出させない」。そのため
**`renderPreview` は、始めた鍵に対して必ず答えを書いて終わること**（成功なら `preview.key`、
失敗・中断なら `previewError.key`）。黙って早期に戻る枝を足すと、その設定では
バッチ全体が保存できなくなる。**唯一の例外が上の 4** —— 答えを書かずに戻るが、
戻る条件（原寸が無い）が解消すると鍵そのものが変わるので、宙ぶらりんにはならない。
成り立たせているのは「原寸は必ず記録される」という約束で、デコードできなかった画像も
ファイルが読めなかった画像も**原寸 0 で `sourceInfo` に入る**（`loadSourceInfo`）。
記録しないのは中断だけ —— そのときは押せる保存ボタンも無い。

判定を「成功したか」ではなく「試し終えたか」にしてあるのも同じ理由で、
代表 1 枚が書けない形式でも残りは変換できる（全件が無理なときは `validate` が別に止める）。

**作り直している間は前の絵を残す**（暗くする・`ConvertPreview` の `stale`）。avif は 1 枚に
数秒かかる（下表）ので、枠を空にすると固まったように見える。残すのは**絵だけ**で、
寸法・バイト数・保存ボタンは今の鍵の結果にしか従わない ——「見えている物を保存できる」を崩さない。
代表を選び直したとき（別の画像）と、理由が出たとき（「書き出せません」の横に絵が在ると嘘になる）は残さない。

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

**実測**（4000×3000 の JPEG・dev ビルド）: 設定変更から結果まで 395〜426ms（うち 300ms は待ち）。
幅を 16ms 間隔で 40 回連打しても、入力が止まってから ~350ms で最終結果に落ち着く。

**エンジンは画面を開いた時点で起こす。** wasm-vips は `getVips()` の遅延初期化なので、
何もしないと**最初の 1 件を処理しようとした瞬間**に約 11.9MB
（`vips.wasm` 5.08 + `vips-heif.wasm` 3.48 + `vips-jxl.wasm` 2.17 + `vips-resvg.wasm` 1.16MB）の
ダウンロードが始まる —— つまり利用者が画像を選び終えてから。実測（本番・冷起動）で
サムネが出るまで 2.5 秒。`ConvertScreen` の mount で `warmEngine()` を呼び、
画像を選んでいる間にこれを重ねる。

- **起こすのはワーカー 1 本だけ。** 実体ごとに 1GiB の線形メモリを予約する（§7.1）ので、
  プール全部を先に起こすと画面を開いただけで数 GiB を抱える。残りはバッチ実行時に自然に
  起きるが、そのときには HTTP キャッシュが温まっているのでダウンロードは要らない。
- **`op:"warm"` は画像を渡さない空リクエスト**（`hashTypes.ts`）。単に `fetch` で HTTP
  キャッシュを温めるのでは足りない —— コンパイルと実体化が最初の 1 件に残る。
- **毎回投げてよい。** 二度目が無駄にならないのはワーカー側の `getVips()` が実体を記憶して
  いるから。`engine === "ready"` で早切りすると、画面を離れて戻ったときに
  `releaseIdlePools()` がプールを畳んでいても温かいと言い続けてしまう。
- 走っている間は `pool.hold()` を取る（キューは空で暇に見えるので、さもないと
  画面切替で温めている最中のプールが畳まれる）。
- **失敗は報せない。** 前倒しは利用者が頼んだ仕事ではないので、`engine` を `"cold"` へ
  戻すだけにする（本当の理由は実際に変換したときに同じ経路で出る）。

**「読み込み中」と「生成中」は画面で区別する**（UI.md §6）。出所は `engine` 1 つで、
プレビューの見出しと保存ボタンの下の行が同じ値を読む。

**表単が埋まりきる前は理由を出さない。** `setSources` は寸法欄を空にし、原寸を書き戻す
`prefillDimensions` はサムネと一緒に後から動く。その隙の `validate` は素通し判定で
「変換する指定がありません」を返すが、それは**利用者が何もしていないうちに出す警告**
（設定を触ると再評価されて目に付く）。`formSettled` が立つまで表示を待たせるだけで、
判定そのものは消さない —— 原寸が届いた後に本当に指定が無ければ従来どおり出る。

入力一覧のサムネは専用の `op:"info"` で取る（`workers/vips.ts::applyInfo`）。
`decodeCanonical` を流用すると 1 枚ごとに**全分解能 RGBA** と dHash を作ることになり、
実測 4000×3000 で 165ms / 45.8MB。`thumbnailBuffer` の shrink-on-load なら 53ms・その確保なし
（出力 webp は同一）。**表示する分（12 件）しか作らない**。

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

### 7.5 プール本数の実測（§4 の既定の根拠）

24 枚（2000×1500）を 800×600 へ変換したときの `stats.elapsedMs`:

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
