#!/usr/bin/env bash
# imgdiff の Windows 自己完結パッケージ（zip）を作る。
#   imgdiff/bin/imgdiff.exe + libvips ランタイム DLL 閉包（libheif/vips-heif 等コーデック込み）
#   imgdiff/lib/vips-modules-8.18/vips-heif.dll  ← libvips が既定の相対探索（bin/../lib/...）で見つける
# レイアウトは MSYS2 mingw64 を模すので、MSYS2 を PATH に入れずとも素の Windows で動く（HEIC/AVIF 含む）。
#
# 前提: MSYS2 mingw64 に libvips + libheif（pacman -S mingw-w64-x86_64-libheif）導入済み。
# 使い方: bash scripts/package-windows.sh  → target/win-package/imgdiff-<ver>-x86_64-pc-windows-gnu.zip
set -euo pipefail
cd "$(dirname "$0")/.."

MINGW="/c/msys64/mingw64/bin"
OBJDUMP="$MINGW/objdump.exe"
MODVER="vips-modules-8.18"
MODULE="$MINGW/../lib/$MODVER/vips-heif.dll"

export PKG_CONFIG_PATH="C:\\msys64\\mingw64\\lib\\pkgconfig"
export PATH="$MINGW:$PATH"

echo "=== build (release) ===" >&2
cargo build --release -p imgdiff >&2

VERSION="$(target/release/imgdiff.exe --version | awk '{print $2}')"
echo "=== packaging imgdiff $VERSION ===" >&2

OUT="target/win-package"
BUNDLE="$OUT/imgdiff"
rm -rf "$OUT"
mkdir -p "$BUNDLE/bin" "$BUNDLE/lib/$MODVER"
cp target/release/imgdiff.exe "$BUNDLE/bin/"
cp "$MODULE" "$BUNDLE/lib/$MODVER/"

# imgdiff.exe と vips-heif.dll の DLL 依存を再帰的に集め bin/ へ（objdump BFS・mingw64 由来のみ）。
# モジュール(vips-heif.dll)のデデプ(libheif 等)も exe と同じ bin/ に置く＝プロセス exe ディレクトリは
# 常に DLL 探索対象なので、lib/ 下のモジュールから解決できる。
declare -A seen
queue=("target/release/imgdiff.exe" "$MODULE")
while [ ${#queue[@]} -gt 0 ]; do
  cur="${queue[0]}"
  queue=("${queue[@]:1}")
  deps=$("$OBJDUMP" -p "$cur" 2>/dev/null | grep "DLL Name:" | sed 's/.*DLL Name: //' | tr -d '\r')
  for d in $deps; do
    if [ -f "$MINGW/$d" ] && [ -z "${seen[$d]:-}" ]; then
      seen[$d]=1
      cp "$MINGW/$d" "$BUNDLE/bin/"
      queue+=("$MINGW/$d")
    fi
  done
done
echo "=== 同梱 DLL: ${#seen[@]} / bundle: $(du -sh "$BUNDLE" | cut -f1) ===" >&2

# zip は Windows の Compress-Archive で確実に作る（cygpath で Windows パスへ変換）。
ZIP_NAME="imgdiff-$VERSION-x86_64-pc-windows-gnu.zip"
WIN_BUNDLE="$(cygpath -w "$PWD/$BUNDLE")"
WIN_ZIP="$(cygpath -w "$PWD/$OUT/$ZIP_NAME")"
powershell.exe -NoProfile -Command "Compress-Archive -Path '$WIN_BUNDLE' -DestinationPath '$WIN_ZIP' -Force" >&2

# manifest.json（release アセットとして同梱。`imgdiff update` が target→zip名+sha256 を引く）。
SHA="$(sha256sum "$OUT/$ZIP_NAME" | awk '{print $1}')"
cat > "$OUT/manifest.json" <<EOF
{
  "version": "$VERSION",
  "targets": [
    { "target": "x86_64-pc-windows-gnu", "asset": "$ZIP_NAME", "sha256": "$SHA" }
  ]
}
EOF
echo "manifest: $OUT/manifest.json (sha256 $SHA)" >&2

echo "$OUT/$ZIP_NAME"
