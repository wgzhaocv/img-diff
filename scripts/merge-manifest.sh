#!/usr/bin/env bash
# リリース用の manifest.json を、各プラットフォームが吐いた manifest-<target>.json から束ねる。
#
# なぜ要るか: `install.ps1` / `install.sh` / `imgdiff update` は **リリースに 1 つだけ在る**
# manifest.json を読み、そこから自分の target の資産名と sha256 を引く。各パッケージ用スクリプトが
# manifest.json を直接書くと、同じリリースに後からアップロードした側が相手を消してしまい、
# もう一方のプラットフォームの導入と自己更新が即座に壊れる。断片を作って最後に合わせる。
#
# 使い方: bash scripts/merge-manifest.sh out/manifest.json path/to/manifest-*.json ...
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <出力 manifest.json> <manifest-<target>.json> [...]" >&2
  exit 2
fi
OUT="$1"
shift

# 版が揃っていない断片を混ぜると、片側だけ古い資産を指す manifest ができる。先に弾く。
versions="$(jq -r '.version' "$@" | sort -u)"
if [ "$(printf '%s\n' "$versions" | wc -l | tr -d ' ')" -ne 1 ]; then
  echo "NG: 断片の version が揃っていません:" >&2
  printf '%s\n' "$versions" >&2
  exit 1
fi

# 一時ファイル経由で書く（jq が途中で失敗したとき、空の manifest.json を残さない）。
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
jq -s '{ version: .[0].version, targets: (map(.targets[]) | sort_by(.target)) }' "$@" > "$TMP"
mv "$TMP" "$OUT"

echo "merged: $OUT" >&2
jq -r '.version as $v | .targets[] | "  \($v)  \(.target)  \(.asset)"' "$OUT" >&2
