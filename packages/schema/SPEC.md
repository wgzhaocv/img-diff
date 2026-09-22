# img-diff 共有仕様（SPEC）

web（TypeScript + wasm-vips でデコード + Rust-core-wasm でロジック）と
CLI（Rust + 原生 libvips）が**同じ結果**を出すための正本。
ロジック（dHash/SSIM/クラスタリング等）は `crates/core` の Rust に一本化し、
CLI は原生に、web は wasm にコンパイルして共有する。出力 JSON の型は TS 側 `src/index.ts`
（および Rust 側 `crates/core/src/report.rs`）がこの仕様に従う。

## 1. ハッシュ仕様（dHash, HASH_ALGO_VERSION = "dhash-1"）

`crates/core` に一本化されるため両端で同一コードだが、回帰防止のため手順を明記する。

1. デコード（CLI: 原生 libvips / web: wasm-vips）。
2. autorotate: EXIF Orientation を適用（HASH.AUTOROTATE = true）。
3. ICC があれば sRGB へ変換（なければ sRGB とみなす）。
4. alpha があれば背景 255（白, FLATTEN_BG）で平坦化。**core が行う**（決定性のため両端共有・
   `core::preprocess::flatten_on_white`）。sRGB 空間で白(255,255,255)に straight-alpha 合成し、alpha=255 にする。
5. 9x8 に**強制**リサイズ（アスペクト無視、kernel = linear）。リサイズは core 内で行い確定的にする。
6. 各ピクセルを 8bit グレースケール化: `gray = round(0.299*R + 0.587*G + 0.114*B)`（Rec.601）。
7. 各行で隣接ピクセル `left < right` を 1 ビット。ビット順は**行優先**（上→下、各行 左→右）、計 64 ビット。
8. hex 16 文字に符号化。**先頭ビット = 最初の hex 文字の最上位ビット（MSB 先頭）**。

距離 = `popcount(a XOR b)`。

> 前処理 1〜3（デコード・autorotate・sRGB）は「デコード側」（libvips / wasm-vips）が、
> 4〜8（白平坦化・リサイズ・グレースケール・dHash）は core が行う。pixelSha256 は手順 4 の後の
> **RGBA バイト列**の SHA-256（白平坦化で alpha=255 のため RGB と 1:1。両端が `flatten_on_white` の出力を
> そのままハッシュすれば一致する）。
> 手順 3↔4 の順序は旧版から入れ替わったが（白合成を sRGB 空間で行う）、dhash-1 は未公開のため版は据え置く。

### デコーダは両端で別物である（保証の範囲）

**保証するのは手順 4〜8（core）の一致であって、手順 1〜3（デコード）の画素一致ではない。**
デコードは CLI が原生 libvips、web が wasm-vips と**別実装**で、ビルド構成も違う。

web の **HEIC（HEVC）だけは wasm-vips でも読めない**（同梱 libheif に HEVC デコーダが無い。
AVIF は読める）ので、`libheif-js`（libde265 入り）で RGBA まで解いてから wasm-vips へ渡す。
同じ HEIC を原生 libvips と突き合わせた実測:

|             | 結果                                                               |
| ----------- | ------------------------------------------------------------------ |
| 寸法        | 一致                                                               |
| 画素        | 異なるバイト 29.9% / **最大差 11**（YCbCr→RGB の色度補間の実装差） |
| SSIM / PSNR | 0.99753 / 47.5dB                                                   |
| **dHash**   | **一致**（hamming 0。9×8 への縮小でならされる）                    |

つまり **`pixelSha256` は両端で異なり得る**。ただし同一性の判定は**同じ実行の中で**
互いを比べるので、グループの構成は変わらない（同じファイル同士は同じ側で同じ値になる）。
`perceptual` 層は dHash が一致する限り同じだが、境界の 1bit で分かれる可能性は残る。

**確かめ方**: `scripts/check-heic-parity.sh`（原生 vips が要るので `vp test` には載せない）。

> **golden 夹具**: `tests/` に固定画像と既知 dHash を置き、CLI/web 両ビルドが同値を出すか検証する。
> **実装済み**: `tests/golden.json` + `tests/fixtures/`。CLI 側は `cargo test`
> （`crates/cli/src/pipeline.rs` の `golden_fixtures_match`）、web 側は `vp test`
> （`apps/website/tests/goldenDecode.test.ts`）が**同じファイル**を読む。
> 2026-09-22 時点で jpg / png / 透過 PNG / EXIF 回転 jpg の 4 枚は**両端が同じ dHash**を出す
> （＝この 4 形式については手順 1〜3 も実際に一致している）。**HEIC はこの集合に入れない** ——
> 上の表のとおり画素が約 29.9% 違うので、一致を一般には主張できない。

## 2. 厳密度の軸（strictness）

一度の索引で `sha256` と `dHash` を**全画像**に計算し、`strictness` は**絞り込み**に過ぎない。
`pixelSha256` は §2.1 のとおり**候補のみ**算出するが、グループ化結果は全算出と逐ビット同一（漏れなし）。

| 値           | 判定                                        | しきい値        |
| ------------ | ------------------------------------------- | --------------- |
| `exact`      | `sha256` 一致                               | なし            |
| `pixel`      | `pixelSha256` 一致（EXIF/再エンコード無視） | なし            |
| `perceptual` | ハミング距離 ≤ `threshold`                  | あり（既定 10） |

### 2.1 pixelSha256 の算出範囲（剪定）

`pixelSha256` は全分解能デコード + 全画素ハッシュで**索引中もっとも高コスト**なため、全画像には算出しない。

- **根拠**: `pixelSha256` と `dHash` は同一の正規化ピクセル（autorotate → sRGB → 白平坦化）から
  導出される。ピクセルが完全一致するなら 9x8 縮小も一致 → **dHash も完全一致（距離 0）**。
  つまり pixel 重複になり得るのは「**dHash が他と完全一致する画像**」に限られる。
- **手順**: 全画像の `dHash` を計算 → dHash 値で HashMap グルーピング（O(N)）→
  **メンバ ≥2 のバケットに属する画像のみ**全分解能デコードして `pixelSha256` を算出。
- **完全性**: 任意の pixel 重複ペアは同一 dHash バケットに入る → 双方とも算出対象 → 取りこぼさない。
  出力は「全算出」と逐ビット同一。
- 候補でない（dHash がユニーク = pixel 重複になり得ない）画像は `ImageRecord.pixelSha256 = null`。
  孤立画像の pixelSha256 は誰とも比較されないため null で実害はない。
- これにより dHash 用の shrink-on-load（9x8 への縮小デコード）が活き、索引全体が大幅に軽くなる。
- CLI / web とも同一ロジック（`crates/core`）。

## 3. compare の各種スコア

- **pixelDiffRatio**: dimsEqual のとき。sRGB 化・白平坦化の後の RGB で、各ピクセルの
  いずれかのチャンネル差 `|a-b| > T`（既定 T=0）を「差分」とし、差分数 / 総ピクセル数。
- **SSIM**: §1 のグレースケール上で計算。窓 8x8 一様、データ範囲 L=255、K1=0.01 / K2=0.03、
  全窓平均を 0..1 で返す。窓は **スライド step=1・完全窓のみ**（左上 x:0..=W-8, y:0..=H-8）、
  各窓は母分散（N=64 で割る）。W か H が 8 未満なら **画像全体を 1 窓**として扱う。
  SSIM の数学的範囲は [-1,1]（反相関で負）だが、本仕様は **0..1 に丸める**（負＝最大級に非類似 → 0）。
- **PSNR**: MSE から算出。MSE=0（同一）は ∞ になるため **100dB で打ち切り**。
  MSE は pixelDiffRatio と同じ RGB バイト上で取る（**alpha は除外**、grayscale ではない）。
- dimsEqual=false（= comparable=false）のとき、pixelEqual / pixelDiffRatio / ssim / psnr は
  すべて **null**（「比較不能」と「比較して不一致」を区別する）。
- **diffImage**（任意の可視化・comparable 時のみ）: pixelDiffRatio と**同一の差分判定**
  （同じ tolerance T）で、差分ピクセルを品紅 (255,0,255)・非差分を A の Rec.601 グレーを
  白側へ淡化（round(gray·0.4 + 255·0.6)）した無彩色に塗った RGBA。品紅の面積が pixelDiffRatio に
  対応し、「全体スコアでは分からない**どこが**違うか」を補う。CLI は `--diff <path>` で PNG を書き出し
  `AssetRef{kind:"path"}` を返す（未指定時は省略）。可視化専用でグルーピングには使わないため
  ビット決定性は要求しない。

## 4. 出力（--json / レポート）

最上位は `Report = ScanReport | CompareResult | CleanReport | FindReport | RenderReport | ConvertReport`、
`kind`（"scan" / "compare" / "clean" / "find" / "render" / "convert"）で判別。
全出力に `producer { app, appVersion, vips, hashAlgo }` を付与。

- `ScanReport`: `images[]` + `groups[]` + `skippedFiles[]` + `stats`。
  **決定性のため `images[]` と `skippedFiles[]` は path 昇順**（`groups[]` は §5 の通り最小メンバ path 昇順）。
- `CompareResult`: `a` / `b` の `ImageRecord` + 各種スコア + 任意の `diffImage`（§3）。比較不能時は §3 の通り null。
- `CleanReport`: §5.1。`FindReport`: §5.2。`RenderReport`: §5.3。`ConvertReport`: §5.4。

`ImageRecord.path` は scan ではルートからの相対パス（`/` 区切り）、compare では入力で与えたパス。
`AssetRef` は `{kind:"path"}` か `{kind:"dataUri"}`（CLI はパス、web は data URI）。

> **CLI の stdout 既定は要約**（`groups[]` + `skippedFiles[]` + `stats` + `producer`、`images[]` を除く）。
> 数千枚で巨大な `images[]` を出して AI のトークンを浪費しないため。完全な `ScanReport`（`images[]` 込み）は
> `--full`（stdout）または `--json <file>`（ファイル）で得る。要約は `kind:"scan"` のままだが `images[]` を持たない部分形。

## 5. グループ化（clustering）

- **exact / pixel**: 同一ハッシュで完全グループ化。`autoDeletable = true`、`maxHamming = null`。
- **perceptual**: ハミング距離 ≤ `threshold` のペアを辺として **union-find** で連結成分。
  ただし知覚的類似は**非推移的**（A~B かつ B~C でも A~C とは限らない）。連結成分は
  チェーンで無関係な画像を同一グループにし得るため、perceptual グループは
  **`autoDeletable = false`（要目視）**、自動削除・回収提案はしない。
  `maxHamming` にグループ内の最大ペア間距離を入れ、UI で「緩さ」を表示する。
- `keeper` は全モードで計算（最大解像度 → 最大バイト → path 昇順）。`reclaimableBytes` も計算するが、
  削除提案は `autoDeletable = true` のグループのみ。

## 5.1 clean（削除）

重複を安全に削除する操作。**削除時点でその場で再スキャン**し（古い出力を信じない）、グループ化（§5）の結果に基づく。

- **対象**: `autoDeletable = true`（exact/pixel）グループの **keeper 以外**のメンバのみ。`keeper` は必ず残す。
  perceptual は `autoDeletable = false` のため**絶対に削除しない**（CLI では厳密度に perceptual を選べない）。
- **既定は dry-run**（`plannedDeletions` を出すだけで削除しない）。`--apply` で初めて実削除する。
  非対話（確認プロンプトなし）＝安全は「dry-run 既定 + 明示 `--apply`」で担保。
- **ゴミ箱送りのみ**（復元可能）。永久削除の口は設けない。
- 出力は `CleanReport`（`kind:"clean"`）。`plannedDeletions[]`（path/groupId/bytes/keeper・path は root 相対）、
  apply 時は各 `deletions[]`（`status:"trashed"|"failed"`, `error?`）、`reclaimableBytes` / `trashedBytes` / `stats`。
  1 件の失敗で全体は止めず per-file に記録する。

## 5.2 find（1 枚を問い合わせ、フォルダ内で類似検索）

「この 1 枚に似た画像がフォルダ内にどれだけあるか」を層別に列挙する操作（scan が全対全でグループ化するのに対し、find は 1 対 N）。
索引は scan と同一（並列デコード + dHash/SHA + redb キャッシュを共有）。

- **入力**: `query`（問い合わせ画像 1 枚）+ `folder`（探索先）。`--threshold`（perceptual 層のハミング閾値・既定 10）、
  `--ext` / `--recurse` は scan と同じ。`--top N` で上位 N 件に切り詰め。
- **層（tier）** は §2 の strictness と同じ 3 軸で、各マッチに付与する:
  - `exact`: `query` と `sha256` 一致（バイト完全同一）。
  - `pixel`: `pixelSha256` 一致（デコード後ピクセル一致・EXIF/再エンコード/寸法無視。dHash 距離 0）。
  - `perceptual`: dHash ハミング距離 ≤ `threshold`（要目視）。
    1 マッチは最上位に該当する 1 層のみ（exact > pixel > perceptual の優先）。`hammingDistance` は層に依らず実距離を入れる。
- **query 自身の除外**: `query` が `folder` 内にある場合、それ自身（絶対パス一致）はマッチから除く。
  同一内容の**別ファイル**は正当な `exact` として列挙する。
- **決定性（§4）**: `matches[]` は **層順（exact→pixel→perceptual）→ ハミング距離昇順 → path 昇順**。`path` は root 相対（`/` 区切り）。
- 出力は `FindReport`（`kind:"find"`）: `query`（`ImageRecord`・path は入力で与えたパス）+ `threshold` +
  `matches[]`（`{path, bytes, width, height, format, tier, hammingDistance}`）+ `skippedFiles[]` + `stats{scanned, skipped, matched, elapsedMs}`。
- find は非破壊（削除しない）。「似たものを消す」は scan → clean を使う。

## 5.3 render（ベクタ→PNG 栅格化）

SVG 等のベクタ画像を PNG に栅格化する補助ツール（imgdiff の本分＝重複検出とは別カテゴリ・非破壊）。
libvips が §1 手順 1〜3 と同じ経路で描画し、透明（straight alpha）を保ったまま PNG を書き出す。

- **入力**: `<PATH>`（SVG ファイル、またはそれを含むディレクトリ）。ディレクトリは `--ext`（既定 `svg`）に合う実ファイルを `--recurse`（既定）で収集。
- **出力先**: 既定は各入力と同じ場所に拡張子 `.png` で書く（`foo.svg`→`foo.png`）。`--out-dir <DIR>` 指定時は入力ルートからの相対構造を保って `<DIR>` 配下へ。
- **既存の扱い**: 出力先が既にあれば **skip**（`--overwrite` で上書き）。元ファイルは決して変更しない。
- **`--scale N`**（既定 1.0）: ベクタを何倍の解像度で描くか。SVG は宣言サイズが小さい（アイコン等）ことが多いため、
  ラスタ拡大でなく **libvips の `scale` で高精細に再描画**する（scale=2 なら 200×200 の SVG → 400×400 PNG）。ラスタ入力には効かない。
- 出力は `RenderReport`（`kind:"render"`）: `scale` + `items[].{src, dst, width, height, bytes, status, error?}` + `stats{scanned, rendered, skipped, failed, elapsedMs}`。
  `status` は `rendered` / `skipped` / `failed`。1 件の失敗で全体は止めず per-file に記録。`items` は `src` 昇順（決定性・§4）。
- **注意**: 重複検出/比較目的なら render は不要。`compare` はパスを直に受けるので `.svg` をそのまま扱え、
  `scan` / `find` / `clean` も `--ext svg` を明示すれば拾える（**既定の `--ext` には入っていない** ——
  web は resvg、CLI は libvips の svgload と描画器が別で、dHash が一致する保証が無いため。§1 の parity 参照）。
  render は PNG そのものが欲しいとき用。

## 5.4 convert（寸法・形式の変換）

画像の寸法と形式を変える補助ツール（`render` と同じく **imgdiff の本分＝重複検出とは別カテゴリ・
非破壊**）。引数の意味と効き方は既存の変換サーバ `image_transform` に合わせてある
（同じ引数で同じ結果になることを実測で確かめた）。

**実装状況**: web（`/convert`）は**1 枚だけ**を扱う。**CLI の `imgdiff convert` は未実装**。
この節は両者が共有する正本なので、CLI を書くときはここだけを見れば足りるように算術まで書き下す。

そのぶん**節の中に「両方」と「CLI だけ」が混在する**ので、所有者は見出しに書く
（`（CLI のみ）` と付いた小節は web が実装しない・個々の規則に注記は付けない）。
1 枚の変換にフォルダの書き込み権限や zip の組み立てを背負わせる意味が無かったので、
web は N 枚を扱うことそのものをやめた。**引数・形式表・EXIF の向き・算術は両方**に掛かる。

### 引数

| 引数 | 型      | 既定             | 取り得る値                                                                                             |
| ---- | ------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `w`  | `u32?`  | なし             | 目標幅                                                                                                 |
| `h`  | `u32?`  | なし             | 目標高                                                                                                 |
| `f`  | enum    | `cover`          | `cover` / `contain` / `fill`                                                                           |
| `g`  | enum    | `center`         | `center` / `north` / `south` / `east` / `west` / `northeast` / `northwest` / `southeast` / `southwest` |
| `bg` | 文字列  | 形式依存（下記） | `transparent` / `average` / 6 桁 hex                                                                   |
| `fm` | 文字列? | 入力と同じ形式   | 出力形式（別名を正規化）                                                                               |
| `q`  | `i32`   | `80`             | `clamp(1, 100)`。範囲外はエラーにせず丸める                                                            |

### 規則（この 4 つが挙動の核）

1. **拡大しない。** `scale = min(target / original, 1.0)`。**画素は決して引き伸ばさない。**
   `scale == 1.0` のとき画素はそのままだが、**`contain` だけは画布が目標寸法になる**
   （足りない分は背景で埋まる。下の「算術」を参照）。`cover` と片側指定と `fill` は
   `scale == 1.0` なら出力も元寸法。
2. **`w` と `h` の両方が在るときだけ `f` が効く。** 片方だけなら常に等比縮小で、`f` も `g` も無視する。
3. **`bg` の既定は出力形式で変わる。** `png` / `webp` / `tiff` → `transparent`、それ以外 → `ffffff`。
4. **no-op 検出（素通し）。** その 1 件について**寸法指定が無く、出力形式も入力と同じ**なら、
   デコードせず**元のバイト列をそのまま出力する**。再符号化すると、何も変えていないのに
   圧縮とメタデータが変わってバイトが一致しなくなる（実測: 無変換の PNG が 889 → 922 バイト）。
   これにより、**読めるが書けない形式（HEIC）も素通りできる**
   （CLI では混在バッチの中を、web では 1 枚として）。
   - **`q` を明示したら素通ししない**（同じ形式のまま画質だけ変えて圧縮し直せる）。
     利用者が触っていない既定値の `q` は「指定していない」と同じ扱い。
   - （CLI のみ）素通しした項目のうち、**デコードせずに済んだものは `width` / `height` を
     0 として報告する**（寸法指定があってその画像には効かなかった場合は、デコード済みなので
     実寸法を報告する）。web は報告を作らない。
   - （CLI のみ）全件が素通しになる指定（寸法も形式も指定していない）は、実行そのものを
     断ってよい。web は断らず、**元のバイト列をそのまま保存させる**
     （1 枚なら「何も変えない」は正当な要求で、実際に落ちる物も元と同一）。

### 算術

`(W, H)` を入力寸法、`(tw, th)` を目標寸法とする。

- **片側のみ指定**: `scale = min(t / d, 1.0)`（`t` は与えられた方、`d` は対応する元の辺）。
  出力は `(round(W·scale), round(H·scale))`。
- **`fill`**: `hscale = min(tw/W, 1.0)`、`vscale = min(th/H, 1.0)` で非等比に縮小。出力は `(tw, th)` 相当。
- **`cover`**: `scale = min(max(tw/W, th/H), 1.0)` で縮小 → 中間寸法 `(W', H')` から `(tw, th)` を切り出す。
  切り出し位置は gravity で決まる。**目標が中間寸法より大きいことが有り得る**ので
  （拡大しない縛りのため）、切り出す幅は `cw = min(tw, W')`・`ch = min(th, H')` に丸め、
  余りは `dx = W' − cw`、`dy = H' − ch`（いずれも 0 以上）:

  | gravity     | left          | top           |
  | ----------- | ------------- | ------------- |
  | `center`    | `floor(dx/2)` | `floor(dy/2)` |
  | `north`     | `floor(dx/2)` | `0`           |
  | `south`     | `floor(dx/2)` | `dy`          |
  | `west`      | `0`           | `floor(dy/2)` |
  | `east`      | `dx`          | `floor(dy/2)` |
  | `northwest` | `0`           | `0`           |
  | `northeast` | `dx`          | `0`           |
  | `southwest` | `0`           | `dy`          |
  | `southeast` | `dx`          | `dy`          |

- **`contain`**: `scale = min(min(tw/W, th/H), 1.0)` で縮小 → `(tw, th)` の画布へ `bg` で埋めて配置する。
  配置位置は上表と同じ式で、`dx = tw − W'`、`dy = th − H'`（余白の分配なので符号が逆になるだけ）。

### 形式

`fm` の別名は `jpeg → jpg` / `tif → tiff` / `heif → heic` に正規化する
（**注意: web 内部の `ImageRecord.format` は逆向きに `jpg → jpeg` へ正規化している。用途が違うので
別の関数であり、片方に寄せてはいけない**）。

| 形式                                | 読み | 書き                  | 備考                                                       |
| ----------------------------------- | ---- | --------------------- | ---------------------------------------------------------- |
| jpg / png / webp / gif / tiff / ppm | ○    | ○                     |                                                            |
| avif                                | ○    | ○                     | libvips の `heifsave` の AV1 経路                          |
| **jxl**                             | ○    | **web のみ ○**        | CLI は Windows 版が libjxl 非同梱のため出せない            |
| **heic**                            | ○    | **×（両方やらない）** | 符号化器が GPL + 特許プールで配布条件が変わる。AVIF が代替 |
| bmp                                 | ×    | ×                     | libvips に loader も saver も無い                          |

品質指定 `q` が**実際に効くのは jpg / webp / avif / jxl だけ**。

- **gif / ppm には渡してもいけない**（libvips がその保存器で `Q` を受け付けず失敗する）。
- **png / tiff は渡しても無視される**（png の `Q` は減色時のみ、tiff の `Q` は jpeg 圧縮時のみ
  効くが、本仕様はどちらも使わない。実測で `q=1` と `q=100` の出力がバイト一致）。

  （**効かないことをどう見せるかは実装側の判断**。web は「効かない欄は出さない」を採っている
  ——`apps/website/UI.md` §6.1。ここは形式ごとの事実だけを定める。）

### EXIF の向き（`image_transform` から意図的に外す点）

**読み込み後に `autorot` を適用する。** 参照元の `image_transform` は EXIF の向きを一切扱わず、
そのため「JPEG → JPEG は出力に向きタグが引き継がれて正しく見えるが、JPEG → PNG では倒れる」という
潜在バグを持つ。imgdiff は §1 の解読（scan / compare）でも `autorot` しているので、convert も揃える。

### 出力先と既存の扱い（CLI のみ）

**この小節の規則はすべて CLI のもの。** web は出力先を選ばせず、1 枚の結果を
ブラウザの既定のダウンロード先へ落とす（保存ダイアログもフォルダ選択も出さない＝
書き込み権限の話が発生しない。同名があっても OS/ブラウザの作法に従うだけで、
skip も上書きもこちらでは決めない）。

`render`（§5.3）と同じ**非破壊**の規則:

- 出力先は**入力とは別に指定する**（入力ルートからの相対構造を保つ）。
- **出力先が既にあれば skip。** 明示的に上書きを指定したときだけ上書きする。
- **入力ファイルは決して変更しない。**
- **出力先が入力の中（同じ場所・その配下）なら拒否する。** 同一性の検査だけでは足りない
  ——「入力 `写真/` に対して出力 `写真/out/`」がすり抜け、上書きを許した状態で元画像が置き換わる。
  判定は**解決済みの絶対パス**で行い、解決できない入力では**上書きを認めない**（fail-closed）。
- **同じ実行の中で出力名が衝突する入力は、始める前に拒否する。**
  形式を変えると `a.jpg` と `a.png` はどちらも `a.webp` になる。これを走らせると
  「先に書けた方が勝ち、負けた方は『既に在るので skip』と区別が付かない状態で報告される」
  ことになり、**どちらが勝つかは処理の並びに依存する**（§4 の決定性に反する）。
  1 件ずつ見ていても気づけない集合の性質なので、**入力一覧を受け取った時点で全部の出力名を
  作って重複を検出し、あれば実行そのものを断る**（途中まで進めて部分的な結果を残さない）。

### 出力レポート（CLI のみ）

web が画面に出すのは変換後の寸法・バイト数・形式だけで、レポートは作らない。

`ConvertReport`（`kind:"convert"`）: `options`（適用した 7 引数の解決後の値）

- `items[].{src, dst, width, height, bytes, status, error?}` + `stats{scanned, converted, skipped, failed, elapsedMs}`。
  `status` は `converted` / `skipped` / `failed`。**1 件の失敗で全体は止めず per-file に記録**。
  `items` は `src` 昇順（決定性・§4）。

## 6. バージョニング / 再現性

- `schemaVersion` は JSON の**形**、`hashAlgo`(= HASH_ALGO_VERSION) は**計算手順**。
  形が同じでも手順が変われば `hashAlgo` を上げ、producer 間で phash を比較してよいかの判断に使う。
- 追加フィールドは後方互換、削除・意味変更は `schemaVersion` を上げる。

## 7. 規模の前提

数百〜数千枚。索引は O(N)、ペア比較は 64bit ハミングの総当たり O(N²) で十分
（数千なら 1 秒未満）。10 万枚超で BK-tree / LSH を検討する（今は不要）。
