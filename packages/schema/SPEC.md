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
3. alpha があれば背景 255（白, FLATTEN_BG）で平坦化。
4. ICC があれば sRGB へ変換（なければ sRGB とみなす）。
5. 9x8 に**強制**リサイズ（アスペクト無視、kernel = linear）。リサイズは core 内で行い確定的にする。
6. 各ピクセルを 8bit グレースケール化: `gray = round(0.299*R + 0.587*G + 0.114*B)`（Rec.601）。
7. 各行で隣接ピクセル `left < right` を 1 ビット。ビット順は**行優先**（上→下、各行 左→右）、計 64 ビット。
8. hex 16 文字に符号化。**先頭ビット = 最初の hex 文字の最上位ビット（MSB 先頭）**。

距離 = `popcount(a XOR b)`。

> 前処理 1〜4 は「デコード側」（libvips / wasm-vips）が行い、5〜8 を core が行う。
> **golden 夹具**: `tests/` に固定画像と既知 dHash を置き、CLI/web 両ビルドが同値を出すか検証する
> （実装前にこの基準を用意する）。

## 2. 厳密度の軸（strictness）

一度の索引で SHA / pixel / dHash を全部計算し、`strictness` は**絞り込み**に過ぎない。

| 値           | 判定                                        | しきい値        |
| ------------ | ------------------------------------------- | --------------- |
| `exact`      | `sha256` 一致                               | なし            |
| `pixel`      | `pixelSha256` 一致（EXIF/再エンコード無視） | なし            |
| `perceptual` | ハミング距離 ≤ `threshold`                  | あり（既定 10） |

## 3. compare の各種スコア

- **pixelDiffRatio**: dimsEqual のとき。前処理 3〜4（白平坦化・sRGB）後の RGB で、各ピクセルの
  いずれかのチャンネル差 `|a-b| > T`（既定 T=0）を「差分」とし、差分数 / 総ピクセル数。
- **SSIM**: §1 のグレースケール上で計算。窓 8x8 一様、データ範囲 L=255、K1=0.01 / K2=0.03、
  全窓平均を 0..1 で返す。
- **PSNR**: MSE から算出。MSE=0（同一）は ∞ になるため **100dB で打ち切り**。
- dimsEqual=false（= comparable=false）のとき、pixelEqual / pixelDiffRatio / ssim / psnr は
  すべて **null**（「比較不能」と「比較して不一致」を区別する）。

## 4. 出力（--json / レポート）

最上位は `Report = ScanReport | CompareResult`、`kind`（"scan" / "compare"）で判別。
全出力に `producer { app, appVersion, vips, hashAlgo }` を付与。

- `ScanReport`: `images[]` + `groups[]` + `skippedFiles[]` + `stats`。
- `CompareResult`: `a` / `b` の `ImageRecord` + 各種スコア。比較不能時は §3 の通り null。

`ImageRecord.path` は scan ではルートからの相対パス（`/` 区切り）、compare では入力で与えたパス。
`AssetRef` は `{kind:"path"}` か `{kind:"dataUri"}`（CLI はパス、web は data URI）。

## 5. グループ化（clustering）

- **exact / pixel**: 同一ハッシュで完全グループ化。`autoDeletable = true`、`maxHamming = null`。
- **perceptual**: ハミング距離 ≤ `threshold` のペアを辺として **union-find** で連結成分。
  ただし知覚的類似は**非推移的**（A~B かつ B~C でも A~C とは限らない）。連結成分は
  チェーンで無関係な画像を同一グループにし得るため、perceptual グループは
  **`autoDeletable = false`（要目視）**、自動削除・回収提案はしない。
  `maxHamming` にグループ内の最大ペア間距離を入れ、UI で「緩さ」を表示する。
- `keeper` は全モードで計算（最大解像度 → 最大バイト → path 昇順）。`reclaimableBytes` も計算するが、
  削除提案は `autoDeletable = true` のグループのみ。

## 6. バージョニング / 再現性

- `schemaVersion` は JSON の**形**、`hashAlgo`(= HASH_ALGO_VERSION) は**計算手順**。
  形が同じでも手順が変われば `hashAlgo` を上げ、producer 間で phash を比較してよいかの判断に使う。
- 追加フィールドは後方互換、削除・意味変更は `schemaVersion` を上げる。

## 7. 規模の前提

数百〜数千枚。索引は O(N)、ペア比較は 64bit ハミングの総当たり O(N²) で十分
（数千なら 1 秒未満）。10 万枚超で BK-tree / LSH を検討する（今は不要）。
