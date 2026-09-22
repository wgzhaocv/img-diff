#!/usr/bin/env bash
# Windows 版 imgdiff を交叉編譯して zip を作る（宿主から叩く入口）。
#
#   bash scripts/build-windows-cross.sh          # 像を建てて（初回のみ）編譯 + 梱包
#   bash scripts/smoke-windows-cross.sh          # 出来た zip を wine で動かして確かめる
#
# **像は arm64（宿主と同じ）で建てる。** 交叉編譯は宿主の架構を問わないので、amd64 にすると
# Rosetta で遅くなるだけ。amd64 が要るのは `.exe` を wine で動かす煙試験だけ。
#
# libvips は MSYS2 の mingw64 パッケージを使う（`docker/windows-cross/fetch-msys2.py`）。
# 既に検証済みの Windows パッケージと同じ出所の二進で、版も mac と同じ 8.18.6。
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="imgdiff-win-cross"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "=== 交叉編譯の像を建てる（初回のみ・MSYS2 から約 100 パッケージ取るので数分）===" >&2
  docker build -t "$IMAGE" docker/windows-cross
fi

docker run --rm -v "$PWD":/src -w /src "$IMAGE" bash scripts/package-windows-cross.sh
