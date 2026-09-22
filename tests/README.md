# tests/ — 両端で共有する golden 夹具

SPEC.md §1 が要求する「固定画像と既知 dHash」。**web と CLI が同じ数値を出すこと**を、
それぞれの試験の枠組みから同じ `golden.json` を読んで確かめる。

| どちら              | 走らせ方     | 中身                                                    |
| ------------------- | ------------ | ------------------------------------------------------- |
| web（wasm-vips）    | `vp test`    | `apps/website/tests/goldenDecode.test.ts`               |
| CLI（原生 libvips） | `cargo test` | `crates/cli/src/pipeline.rs` の `golden_fixtures_match` |

**ここが守る範囲が `crates/wasm` の parity と違う。** あちら（`crates/wasm/src/lib.rs` の
`GOLDEN`）は**合成 RGBA から始まる**ので、デコーダを 1 つも通らない ——
原生 libvips と wasm-vips がずれても緑のままになる。こちらは実ファイルから始めるので、
手順 1〜3（デコード・autorot・sRGB）まで含めて端から端までを押さえる。

なお **HEIC はここに入れない**。両端で画素が約 29.9% 違う（SPEC §1 の表）ので
「同じ dHash になる」を一般には主張できない。HEIC は `scripts/check-heic-parity.sh` が
その夹具 1 枚について確かめるだけ、という位置づけのまま。

## 夹具の作り方（作り直すときは `golden.json` の sha256 と dhash も更新する）

撮影物ではなく vips で合成している（配布条件の心配が無く、作り直しが再現できる）。

```sh
# ripple.png — 縦横どちらにも構造がある可逆画像
vips sines g.v 320 240 --hfreq 2.7 --vfreq 0.6
vips linear g.v g8.v 110 130 --uchar
vips cast g8.v tests/fixtures/ripple.png uchar

# photo.jpg — JPEG（IDCT と chroma upsampling の実装差が出る）
# **3 面それぞれ別の模様**にする。同じ模様を 3 回並べると全画素 R==G==B になり、
# 4:2:0 でも色度が一定＝色度補間を一度も試験できない（最初それで作ってしまった）。
vips sines sa.v 256 192 --hfreq 1.1 --vfreq 0.3
vips sines sb.v 256 192 --hfreq 0.2 --vfreq 1.7
vips sines sc.v 256 192 --hfreq 2.3 --vfreq 2.1
vips linear sa.v ra.v 120 135 --uchar
vips linear sb.v rb.v 120 120 --uchar
vips linear sc.v rc.v 120 110 --uchar
vips bandjoin "ra.v rb.v rc.v" rgb.v
vips cast rgb.v "tests/fixtures/photo.jpg[Q=85]" uchar

# alpha.png — 透過あり RGBA（手順 4 の白平坦化が効く）
vips sines p.v 256 192 --hfreq 0.8 --vfreq 1.3
vips linear p.v p8.v 127 128 --uchar
vips bandjoin "p8.v p8.v p8.v p8.v" prgba.v
vips cast prgba.v tests/fixtures/alpha.png uchar
```

`rotated.jpg` は EXIF の向きが付いた実ファイル（合成では作っていない）。
**ヘッダの寸法と autorot 後の寸法が違う唯一の入力**なので、置き換えない。

期待値の採り直しは CLI 側から:

```sh
cargo run -q -p imgdiff -- scan tests/fixtures -o json --full | jq '.images[] | {path, width, height, phash}'
shasum -a 256 tests/fixtures/*
```

**採り直した値をそのまま信じない。** 両端が食い違ったときは、どちらが変わったのかを先に確かめる
（SPEC §1 は手順 4〜8 の一致しか約束していないので、デコーダ側が変わったなら
「一致しない」という事実の方を記録する）。
