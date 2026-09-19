# NEXT — 次セッションへの引き継ぎ

このファイルは**片付いたら削除する一時ファイル**。ロードマップの正本は `TODO.md`、
仕様の正本は `packages/schema/SPEC.md`、web の視覚は `apps/website/UI.md`。
ここに**永久記録を書かない**（決まったことは SPEC / TODO へ移す）。

利用者からの依頼は 2 件:

1. **画像フォーマット変換**を足す（できる変換は `~/Desktop/projects/image_transform` の
   受け付ける引数とその処理を参考にする）
2. **似た画像が見つかったときに削除できる**ようにする

**利用者の決定（2026-09-18）**: **wasm-vips は自前ビルドしない。配布物の npm パッケージを使う。**
引数の効き方が `image_transform` と同じにできるなら、**HEIC 出力は落として良い**（§1.4）。

**どちらも「実装するだけ」では終わらない。**

- 1 は SPEC に前例（§5.3 render）が在り、**参照元の README が実装より広い**（§1.2）。
  引数の処理は**実測で 1:1 に再現できると確かめた**（§1.2 の表）。
- 2 は**現状と食い違う** — 自動削除は既に在るが、利用者が言う「似た画像」は
  SPEC が**自動削除しないと決めている層**（§2）。

着手前にこの 2 つを読んでほしい。

---

## 0. 先に確かめた事実（この引き継ぎを書いた時点の実測）

- **削除は既に在る。** `imgdiff clean`（CLI・SPEC §5.1）と、web の実削除
  （`apps/website/src/lib/clean.ts` + `DeleteDuplicatesButton.tsx` + `scanStore.deleteDuplicates`）。
  commit `362db82`、本番 version `7db507e2` でデプロイ済み。
- **ただし対象は `autoDeletable = true`（exact / pixel）のみ。** perceptual グループは
  `DuplicateGroups.tsx` が「要目視（自動削除しない）」と表示するだけで、**選ぶ手段も消す手段も無い**
  （チェックボックス等の選択 UI は 1 つも無い — grep 済み）。
- **web には変換機能が無い。** CLI には SPEC §5.3 `render`（SVG → PNG 栅格化）だけが在る。
- **コーデックは「符号が在る」では判断できない。** `vips.wasm` の strings には `heifsave` も
  `jxlsave` も在るが、**本番の頁で実際に呼ぶと半分は失敗する**（動的モジュールとコーデックの
  有無で決まる）。下表は **本番の img-diff をブラウザで開き、`workers/vips.ts:41` と同じ初期化
  （`dynamicLibraries: ['vips-heif.wasm','vips-resvg.wasm']`）で 16×16 の画像を
  `writeToBuffer(<拡張子>)` して得た実測**（2026-09-18）:

  | 出力                                                 | 結果                                                 |
  | ---------------------------------------------------- | ---------------------------------------------------- |
  | `.jpg` / `.png` / `.webp` / `.gif` / `.tif` / `.ppm` | **書ける**                                           |
  | `.avif`                                              | **書ける**（534 B。`heifsave` の AV1 経路）          |
  | `.heic`                                              | **書けない** — `heifsave: Unsupported compression`   |
  | `.jxl`                                               | **書けない** — `".jxl" is not a known buffer format` |
  | `.bmp`                                               | **書けない** — 同上（`magicksave` が無い）           |

  読み込みは広い（svg も可。`vips-resvg.wasm` が在る）。
  **`dynamicLibraries` を空にすると `.avif` も落ちる** — heif モジュールを読んで初めて通る。

- **幾何/色の操作は全部在る**（同じく実測。`typeof im[m] === "function"`）:
  `resize` / `extractArea` / `extractBand` / `embed` / `addalpha` / `colourspace` / `avg` /
  `thumbnailImage` / `flatten` / `smartcrop` / `rot` / `autorot`。
  ⇒ **§1.1 の引数処理は、コーデック以外すべて再現できる。**

---

## 1. 画像フォーマット変換

### 1.1 `image_transform` が受け付ける引数（実コードで確認済み）

正本は `~/Desktop/projects/image_transform`。README にも表が在るが、**README と実装が食い違う点が
在った**ので、以下はコードを読んで書いた（出典を各行に付す）。

| 引数 | 型               | 既定             | 取り得る値 / 処理                                                                                      | 出典                                   |
| ---- | ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `w`  | `Option<u32>`    | なし             | 目標幅                                                                                                 | `handlers/transform.rs:26`             |
| `h`  | `Option<u32>`    | なし             | 目標高                                                                                                 | 同上                                   |
| `f`  | enum             | `cover`          | `cover` / `contain` / `fill`（小文字のみ）                                                             | `transform/options.rs:8-21`            |
| `g`  | enum             | `center`         | `center` / `north` / `south` / `east` / `west` / `northeast` / `northwest` / `southeast` / `southwest` | `options.rs:44-61`                     |
| `bg` | 自由文字列       | 形式依存（下記） | `transparent` / `average` / **それ以外はすべて hex 扱い**                                              | `options.rs:120-133`                   |
| `fm` | `Option<String>` | 元の形式         | 別名を正規化（`jpeg`→`jpg` / `tif`→`tiff` / `heif`→`heic`）                                            | `transform_helper/normalize_format.rs` |
| `q`  | `Option<i32>`    | `80`             | **`clamp(1, 100)`** で丸める（範囲外はエラーにしない）                                                 | `options.rs:225-228`                   |

**引数の処理でそのまま真似したい規則（README には薄くしか書いていない）:**

- **拡大しない。** `w` / `h` が元画像より大きくても `scale = (target / original).min(1.0)` で
  頭打ち（`transform/core/apply_transformation.rs:14,47`）。`scale == 1.0` なら元画像をそのまま返す。
- **`w` と `h` の両方が在るときだけ `f` が効く。** 片方だけなら常に等比縮小で、`f` も `g` も無視
  （`apply_transformation.rs:37-51`）。
- **`bg` の既定は出力形式で変わる**: `png` / `webp` / `tiff` → `transparent`、それ以外 → `ffffff`
  （`options.rs:239-247`）。
- **`bg` は 6 桁 hex のみ**。`#` は剥がすが 3 桁短縮形は受けない（`to_rgb` が `None` を返す。
  `options.rs:148-161`）。**不正な値でもエラーにならず hex として保持される**ので、
  web に移すなら**入口で弾く**か、`None` のときの落とし所を決めること。
- **no-op 検出**: 変換引数が 1 つも無い / 結果が元と同じなら元画像を返す（`transform.rs:52-73`）。

### 1.2 引数の処理は 1:1 に再現できる（実測済み）

`image_transform` が使う vips 操作は 14 個で、**wasm 側に全部在る**。
下は `wasm-vips@0.0.18` の npm 配布物を node で動かして**実際に確かめた**結果（2026-09-18）:

| `image_transform` の挙動       | wasm でどう作るか                                | 実測                                       |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------ |
| `f=cover`（切り抜き）          | `resize` → `extractArea`                         | ✓ 100×50 → 40×30                           |
| `f=contain` + hex 背景         | `embed{extend:"background", background:[r,g,b]}` | ✓ 角が `[255,255,255]`                     |
| `f=contain` + `bg=transparent` | `addalpha` → `embed{background:[0,0,0,0]}`       | ✓ 4 バンド・角が `[0,0,0,0]`・PNG に alpha |
| `f=fill`（引き伸ばし）         | `resize(hscale, {vscale})`                       | ✓ 100×50 → 50×100                          |
| `bg=average`                   | `extractBand(i).avg()` を 3 回                   | ✓ `[200,100,50]` を取り出せた              |
| `g=`（9 方向）                 | `extractArea` / `embed` のオフセット計算         | 純粋な算術。依存なし                       |
| `q=`（1-100 clamp）            | 各 save の `Q`                                   | ✓                                          |
| 拡大しない `.min(1.0)`         | 純粋な算術                                       | —                                          |
| 別名の正規化                   | 純粋な文字列処理                                 | —                                          |

**色管理は要らない。** ICC / EXIF / 動画フレームの処理は **`image_transform` 側にも無い**
（全体で `colourspace(Srgb)` が TIFF 保存前に 1 回だけ。`grep` 済み）。その `colourspace` も
wasm 側に在る。**lcms の有無を心配する必要はない。**

### 1.2.1 形式の差（ここだけが違い）

| `fm`                                | image_transform                             | img-diff(web)                                   |
| ----------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| jpg / png / webp / gif / tiff / ppm | ○                                           | **○**                                           |
| **avif**                            | ○（`heifsave` + `compression: Av1`）        | **○**（往復確認済み）                           |
| **jxl**                             | **分岐が無い**（`_ =>` の汎用保存に落ちる） | **○**（`vips-jxl.wasm` を積めば。往復確認済み） |
| **heic**                            | ○                                           | **×** — **落とすと決めた**（§1.4）              |
| **bmp**                             | △ 汎用保存任せ                              | × — vips では出せない                           |

⇒ **複刻後の img-diff は、image_transform より JXL が 1 つ多く、HEIC が 1 つ少ない。**

**読み込みは HEIC も含めて通る**（実測: heic の magic で `VipsForeignLoadHeifBuffer` が選ばれる。
一方 bmp は `not in a known format` ＝ loader ごと無い）。**iPhone 写真を読む用途に影響は無い** —
落とすのは「HEIC で書き出す」だけ。

**`image_transform` の README は実装より広い。** `avif` は専用 saver ではなく `heifsave` の
AV1 指定、`bmp` は汎用保存任せ、**`jxl` は分岐すら無い**（`core/save_image.rs:13-85` を数えた）。
**README を写すと両側の嘘を引き継ぐ。**

### 1.3 決めてほしいこと（実装より先に）

1. **どこに置くか。** SPEC §5.3 `render` が既に「imgdiff の本分＝重複検出とは**別カテゴリ**・
   **非破壊**」という前例を作っている。変換もこの枠に入れるのが素直で、その場合:
   - **元ファイルを書き換えない**（別名保存）。`render` は `foo.svg` → `foo.png` で
     既存が在れば skip、`--overwrite` で初めて上書き。
   - SPEC に `§5.4 convert` を足し、CLI と web が同じ規則を共有する（`render` と同様に
     `ConvertReport` を定義）。**web だけに先に入れると SPEC が正本でなくなる。**
2. **出力先。** ブラウザでは 2 通りある:
   - **ダウンロード**（Blob + `<a download>`。権限不要・実装が軽い・大量だと非現実的）
   - **フォルダへ書き戻す**（FS Access の `createWritable`。`readwrite` 権限が要る＝
     削除と同じ昇格が要る。`fsaccess.ts` に `requestWritePermission` が既に在る）
     **両方入れる**（利用者の方針「出来ることは全部やる」）。ただし**書き戻しは非破壊を保つ**:
     `render` の前例どおり**別名で書き**、既存が在れば skip、上書きは明示指定のときだけ。
     書き戻しは削除と同じ `readwrite` 昇格を使うので、**強確認の型は §2.3 の物を流用する**。
3. **scan の結果画面から繋ぐか、独立した画面にするか。** 現状 web は
   `scan` / `compare` / `install` の 3 ルート（react-router v8）。変換は 4 つ目の
   `/convert` が素直（scan の結果に混ぜると「重複検出の道具」という軸がぼやける）。

### 1.4 wasm-vips は自前ビルドしない（**決定**・2026-09-18）

**決定**: 配布物の npm パッケージ（`wasm-vips@^0.0.18`）をそのまま使う。**HEIC 出力は作らない。**

**何を前提にした決定か**（前提が変わったら見直す）:

1. **引数の効き方は 1:1 に再現できる**（§1.2 の実測）。利用者の条件
   「各引数が transform と同じ効果を出せるなら」が満たされている。
2. **足りないのは HEIC の「書き」だけ。読みは通る** — iPhone 写真を扱う経路は影響を受けない。
3. **AVIF が代替になる**。同じ `heifsave` 経路で、圧縮率は HEIC より良い。
4. **自前ビルドの代価が大きい**: HEVC 符号化器（x265）は **GPL**、HEVC は**特許プール** ⇒
   配布物のライセンス条件が変わる。加えて上流追随のためのビルド鎖を持つことになる。

**⇒ この 4 つのどれかが崩れたら**（例: 「HEIC で保存したい」という実需が出た / 上流が
HEVC 入りの配布を始めた / ライセンス条件が変わった）、**この決定を見直す**。

#### 今すぐ足せるもの（ビルド不要）

- **JXL — 設定 2 行。** `vips-jxl.wasm`（2.07MB）は**既に npm パッケージに入っている**。
  img-diff が積んでいないだけ（`vite.config.ts:20` の注釈「jxl は CLI 非対応につき積まない」）。
  1. `vite.config.ts` の `files` 配列に `"vips-jxl.wasm"` を足す
  2. `workers/vips.ts:41` の `dynamicLibraries` に `"vips-jxl.wasm"` を足す

  **動的モジュールなので既定の scan 経路は重くならない**（使う時だけ読む）。
  なお **CLI 側は JXL 非対応**なので、web だけ形式が増える。SPEC に書くときは
  「web のみ」と明記する（両者の差は SPEC が持つ）。

- **BMP — vips では出せない。** `magicksave` が無く、汎用保存も効かない（実測）。
  出したいなら RGBA から**自前で書く**（BMP ヘッダは単純で数十行）。
  ただし **`image_transform` 側も専用分岐が無い**ので、**揃えるなら「両方やらない」で揃う**。
  **初版では作らない**のが素直。

#### 差し替えるときの注意（将来 wasm-vips を上げる場合）

**`vips*.wasm` を差し替えたら、デコードの parity（dHash / pixelSha256 の golden）を必ず再実行する**
（`cargo test -p imgdiff-wasm` + `wasm-pack test --node crates/wasm`）。
デコード結果が動くと**重複判定が静かに変わる**。ここを飛ばすのが一番危ない。

### 1.5 性能（利用者の指示: \*\*worker / OffscreenCanvas / SharedArrayBuffer を使えるだけ使う。

ただし要らない所に強引に使わない\*\*）

**既に在るもの（作り直さない）:**

- **Worker 固定プール** `lib/workerPool.ts::HashPool`。本数は **`min(hardwareConcurrency, 8)`**
  （`workerPool.ts:95-97`・DESIGN §4）。1 ワーカー = 同時 1 件、死んだら補充。
- **Transferable で zero-copy** 受け渡し（`workerPool.ts:70` / `hash.worker.ts:130`）。
- **SharedArrayBuffer は既に効いている** — wasm-vips が pthreads ビルドで、COOP/COEP が
  揃っているから初期化できる（これが無いと引擎ごと起動しない）。
- **ただし `vips.concurrency(1)`**（`workers/vips.ts:43`）= **シングルスレッド vips × N ワーカー**。
  これは DESIGN §4 の**意図した選択**で、「vips 内部で pthread を使う」のと二者択一。
  TODO.md §2 が **「pthread 過剰購読・N×vips メモリ」を要計測**として残している。
  **数える前に触らない**（`concurrency(N)` に上げると、N ワーカー × N スレッドで過剰購読になる）。

**足す判断の原則（利用者の補足）**: **要らない所に強引に持ち込まない。**
この repo は既に「**実利が出てから**」（TODO.md §3 の C-3 仮想化 / C-4 shrink-on-load）と
「**先に計測**」を方針にしている。下の各項は**そのまま着手して良い物**と
**測ってからの物**に分けてある。**分類ごと守る。**

**A. 理由がはっきりしている（着手して良い）:**

- **OffscreenCanvas — ここが本当の空白。** 差分ハイライトの描画は今**メインスレッド**で
  `putImageData` している（`components/CompareView.tsx:212-231`）。大きい画像ほど UI が固まる。
  `canvas.transferControlToOffscreen()` でワーカーへ渡し、**RGBA を転送せずワーカー内で描く**。
  今は差分 RGBA を Transferable で**メインへ運んでから**描いているので、運ぶ物自体が消える。
  **理由**: 実害（大きい画像で UI が固まる）と、消える仕事（RGBA の転送そのもの）が
  両方はっきりしている。
- **変換（§1）はワーカーで動かす。** 変換は本質的に「N 枚を独立に処理する」ので、
  既存の `HashPool` と同型（1 ワーカー = 同時 1 件）に載るのが自然。
  **新しい池を作らず `HashPool` を一般化する**方が、本数の管理が 1 箇所で済む。
  出力バッファが大きいので**返しは Transferable**。
  **理由**: 並列化しないと N 枚が直列になる。既存の型にそのまま載るので追加の複雑さがほぼ無い。

**B. 測ってから決める（今は触らない）:**

- **`createImageBitmap`** — サムネ生成/プレビューで使える（`ImageBitmap` は Transferable）。
  **ただし今そこが遅いという実測は無い**（TODO.md の実測は WARM ~90ms）。
  **先にプロファイルを取り、canvas 経由の再デコードが実際に効いていると分かってから。**
- **`vips.concurrency` の見直し** — 上記のとおり現状は意図した `1`。変換は scan と違い
  「少数の大きい画像」になりがちで**最適な形が違う可能性**は在るが、
  **過剰購読の測定（TODO.md §2 の宿題）を済ませてから**。用途ごとに別の値を持つのも有り得る。
- **SharedArrayBuffer を「もっと使う」** — 現状 SAB は wasm-vips の pthreads が使っている。
  ワーカー間で SAB を自前で共有する形（例: 共有リングバッファ）は、
  **今は Transferable で足りている**（zero-copy は既に達成済み）。
  **Transferable で足りない所が出てから**。

**測り方**: TODO.md の「性能」節が実測の型を残している（実画像 60 枚 COLD ~2.3s / WARM ~90ms）。
同じ計り方で before/after を出す。**`--release` 相当（本番ビルド）で測る**こと。

---

## 2. 「似た画像の削除」— **現状と食い違う。まずここを読む**

### 2.1 何が食い違うか

利用者の依頼は「**似た**画像が見つかったときに削除」。ところが:

- 今の削除が対象にするのは **`autoDeletable = true`＝ exact（バイト同一）と pixel（画素同一）だけ**。
- **perceptual（＝「似ている」）は SPEC §5 が `autoDeletable = false` と決めていて、
  「自動削除・回収提案はしない」と明記されている。** 理由は**知覚的類似が非推移的**だから
  （A~B かつ B~C でも A~C とは限らない）。union-find の連結成分はチェーンで**無関係な画像を
  同じグループに入れ得る**ので、そのまま消すと**別物を消す**。
- CLI は更に踏み込んで「厳密度に perceptual を選べない」（SPEC §5.1）。

**つまり「似た画像も消せるようにする」は、機能追加ではなく SPEC の決定を変える話。**
黙って `autoDeletable` を無視する実装を書くと、SPEC がその瞬間に嘘になる。

### 2.2 食い違いの解き方 — **案 A に決定（利用者・2026-09-19）**

**決定: 案 A（人が 1 枚ずつ選ぶ）。** perceptual グループは自動では 1 枚も選ばない。
`clean` とは別の名前（例 `delete-selected`）で SPEC に節を足し、選択 UI を web に足す。
`keeper` を消せるようにするか（＝グループ全滅を許すか）は実装時に決める。
以下は決定に至った比較（記録として残す）。

- **案 A: 1 枚ずつ人が選ぶ（推奨）。** perceptual グループは**自動では 1 枚も選ばない**まま、
  サムネにチェックボックスを付けて**人が選んだ物だけ**消す。SPEC §5 の「自動削除しない」は
  保ったまま（自動で提案していない）、消す判断は人が持つ。
  - この場合**これは `clean` ではない**。`clean` は §5.1 で「autoDeletable の keeper 以外」と
    定義済みなので、**別の名前**（例: `delete-selected`）にして SPEC に節を足す。
    同じ名前に 2 つの意味を持たせると、CLI と web で規則が割れる。
  - `keeper` はどうするか要決定。人が選ぶなら keeper も消せて良いはずだが、
    **グループが全滅する**選択を許すかは別問題（「1 枚は残す」を強制するかどうか）。
- **案 B: perceptual も自動削除の対象にする（非推奨）。** 非推移性の問題が残るので、
  やるなら「連結成分ではなく**全対全で距離 ≤ threshold を満たす完全グラフの塊**だけ自動可」
  のような、グループ化側の変更が要る。**SPEC §5 の否決を覆す話**なので、覆すなら
  その根拠（何を前提にした否決だったか）ごと SPEC に書き直す。

### 2.3 実装で再利用できるもの / 足りないもの

**再利用できる（既に在る）:**

- `fsaccess.ts::removeByPath`（親 dir を辿って `removeEntry`）と `requestWritePermission`。
- `scanStore.deleteDuplicates` の**安全の型**: click 内で `readwrite` 昇格（transient activation）→
  per-file 記録（1 件失敗で止めない）→ **世代ガード**（削除中に新スキャンで `result` が
  差し替わっていたら書き戻さない）→ `gcOrphans` で IDB 整合。
- `DeleteDuplicatesButton` の**強確認 AlertDialog**（「元に戻せません・ゴミ箱なし・恒久」を
  アイコン＋テキストで明示＝色に依存しない。件数 / 回収バイト / 対象一覧の dry-run プレビュー）。

**足りない:**

- **選択 UI が 1 つも無い**（チェックボックス / 選択状態のストア / 「全選択」「keeper 以外を選択」）。
- **File[] 経路では削除できない**（永続 handle が無い）。現状もこの経路はボタンを出していない。
  選択 UI を足すときも同じ扱いにすること。

### 2.4 忘れずに

- **web の削除は恒久**（ブラウザにゴミ箱が無い＝`removeEntry` は復元不可）。CLI は `trash` crate で
  ゴミ箱送り。**この非対称は既に `clean.ts` の頭注釈に書いてある** — 選択削除でも同じ強確認を通すこと。
- **FS Access 経路（有効ボタン → AlertDialog → 実削除）は E2E 未検証のまま本番に出ている**
  （TODO.md §3(A)）。選択削除を足す前後で、ここを一度実機で通すのが良い。

---

## 3. 進め方（この repo の作法）

- コードのコメントと文字列は**日本語**（`CLAUDE.md`）。利用者との会話は中国語。
- **何でも手搓しない**（`[[prefer-libraries-not-handrolled]]`）。選択 UI も既存の
  `components/ui` と zustand ストアに寄せる。
- web の視覚は `apps/website/UI.md` が正本。前端を触ると skill `imgdiff-ui` が自動で載る。
- 仕上げは **simplify agent → codex rescue agent**（skill ではなく agent）。
  **破壊的な実削除は特に念入りに**（TODO.md の但し書き）。
- 検証は `vp check` と `vp test`。Rust を触ったら `cargo test`（wasm は
  `wasm-pack test --node crates/wasm`・要 mingw on PATH）。

## 4. 未確認（次のセッションが最初に潰すと良い）

- **repo の最終 commit は `4727905`（2026-07-06）だが、ポラリスに上がっている
  `img-diff` の配信物は 2026-09-18 に上げられたもの。** 同じ版かどうか照合していない。
  web を触る前に、**今の master を build した出力が本番と一致するか**を確かめること
  （食い違うなら、本番にだけ在る変更を先に回収する）。
