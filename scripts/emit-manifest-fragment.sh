#!/usr/bin/env bash
# manifest の「1 target 分」の断片を書き出す。各プラットフォームのパッケージ用スクリプトが共有する。
#
# ここが **manifest スキーマの唯一の正本**。消費者は 4 つある:
#   crates/cli/src/update.rs（serde）/ apps/website/public/install.ps1 / install.sh /
#   scripts/merge-manifest.sh（jq）。スキーマを増やすときはここだけ直せば両プラットフォームに届く。
#
# 使い方: bash scripts/emit-manifest-fragment.sh <出力ディレクトリ> <zip 名> <version> <target>
set -euo pipefail

OUT="$1"
ZIP_NAME="$2"
VERSION="$3"
TARGET="$4"

# coreutils(sha256sum) と macOS(shasum) の差だけ吸収する。
if command -v sha256sum >/dev/null 2>&1; then
  SHA="$(sha256sum "$OUT/$ZIP_NAME" | awk '{print $1}')"
else
  SHA="$(shasum -a 256 "$OUT/$ZIP_NAME" | awk '{print $1}')"
fi

cat > "$OUT/manifest-$TARGET.json" <<EOF
{
  "version": "$VERSION",
  "targets": [
    { "target": "$TARGET", "asset": "$ZIP_NAME", "sha256": "$SHA" }
  ]
}
EOF
echo "manifest: $OUT/manifest-$TARGET.json (sha256 $SHA)" >&2
