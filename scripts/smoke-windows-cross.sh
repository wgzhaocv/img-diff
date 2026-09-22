#!/usr/bin/env bash
# 交叉編譯した Windows 版 imgdiff を **wine で実際に動かして**確かめる。
#
# **ここだけ amd64 の容器を使う**（宿主が Apple Silicon なら Rosetta。遅いが 1 回だけ）。
# 編譯そのものは架構を問わないので `docker/windows-cross` は arm64 のまま ——
# 全部 amd64 にすると、得が無いのに全工程が遅くなる。
#
# 確かめること:
#   1. **そもそも起動する**（DLL の取りこぼしはここでしか出ない。`objdump` は「在るはず」までしか言わない）
#   2. `--version` が「packaging が名乗った版と target」と一致する
#      ——交叉編譯では実行ファイルに聞けないので、`package-windows-cross.sh` は
#        `cargo metadata` と triple から名乗っている。**その名乗りが正しいかはここで初めて判る。**
#   3. **dHash が golden と一致する**（`tests/golden.json`）。原生 mac / wasm と同じ値を出すか。
#   4. **HEVC の HEIC が読める** —— `vips-heif.dll` モジュールと `libde265` を同梱できているか。
#      ここは一度黙って壊れた: `bundle_root()` が返す Windows の canonicalize 結果は `\\?\` 付きで、
#      それを `VIPSHOME` として渡すと libvips が解釈できずモジュールを見失う（`util::strip_verbatim`）。
#
# 使い方: bash scripts/smoke-windows-cross.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ZIP="$(ls target/win-package/imgdiff-*-x86_64-pc-windows-gnu.zip 2>/dev/null | head -1)"
[ -n "$ZIP" ] || {
  echo "zip が無い。先に scripts/build-windows-cross.sh" >&2
  exit 1
}
echo "=== 煙試験: $ZIP ===" >&2

IMAGE="imgdiff-win-smoke"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "=== wine 入りの amd64 像を建てる（初回のみ・Rosetta なので遅い）===" >&2
  docker build --platform linux/amd64 -t "$IMAGE" -f docker/windows-cross/Dockerfile.smoke docker/windows-cross
fi

docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src "$IMAGE" bash scripts/smoke-windows-cross-inner.sh
