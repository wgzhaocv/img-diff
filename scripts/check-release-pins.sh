#!/usr/bin/env bash
# 発版しようとしている版と、web の導入導線が指している tag が一致するか確かめる。
#
# **ここで止めないと無言で壊れる**: install.sh が別の tag を指したまま発版すると、
# 利用者には何のエラーも出ないまま**古い版が配られ続ける**。
# 使い方: bash scripts/check-release-pins.sh <version>   （例: 0.1.6）
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?版を渡してください（例: 0.1.6）}"

check_pin() {
  local found
  found="$(grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' "$1" | sort -u || true)"
  if [ -z "$found" ]; then
    return 0 # tag を固定していない（latest 追従）ならチェック不要
  fi
  if [ "$found" != "v$VERSION" ]; then
    echo "NG: $1 の tag 固定が v$VERSION と一致しません（見つかったのは: ${found}）" >&2
    exit 1
  fi
}

check_pin apps/website/public/install.sh
check_pin apps/website/src/screens/InstallScreen.tsx
