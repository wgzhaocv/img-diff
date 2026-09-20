#!/usr/bin/env bash
# imgdiff の macOS 自己完結パッケージ（zip）を作る。package-windows.sh と同じ束レイアウト:
#   imgdiff/bin/imgdiff
#   imgdiff/lib/vips-modules-<maj>.<min>/vips-heif.dylib, vips-jxl.dylib
#   imgdiff/lib/*.dylib                                   ← 依存 dylib の閉包
# libvips は `<prefix>/lib/vips-modules-X.Y` からモジュールを読む。prefix は
# decode.rs::set_bundled_vipshome が VIPSHOME で束ルートへ向ける（macOS の libvips は
# 自分の位置を知る術が無く、ビルド時プレフィックスが argv0 より先に試されるため必須）。
#
# 前提: brew install vips libheif dylibbundler
# 注意: 本機の Homebrew ボトルは LC_BUILD_VERSION minos が macOS 26 → **できた zip は macOS 26+ 専用**。
#       もっと古い OS を賄うには対応する macOS runner（CI）で焼く必要がある。
# 使い方: bash scripts/package-macos.sh → target/macos-package/imgdiff-<ver>-<target>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

BREW_PREFIX="$(brew --prefix)"
VIPS_LIB="$(brew --prefix vips)/lib"
# vips のモジュールディレクトリ名は libvips の major.minor に従う（バージョン固定を避けて実体から拾う）。
MODDIR="$(basename "$(find "$VIPS_LIB" -maxdepth 1 -type d -name 'vips-modules-*' | head -1)")"
# 同梱するモジュール: heif(HEIC/AVIF) と jxl のみ。magick/poppler/openslide は依存が巨大なので入れない。
MODULES=(vips-heif.dylib vips-jxl.dylib)

echo "=== build (release) ===" >&2
cargo build --release -p imgdiff >&2

# version と target は**実行ファイル自身に聞く**（`--version` は "imgdiff <ver> (<target>)"）。
# target を `rustc -vV` の host から別途導出すると、クロスビルド時に実行ファイルへ埋めた
# IMGDIFF_TARGET と食い違い、その環境の `imgdiff update` が恒久的に manifest を引けなくなる。
read -r _ VERSION TARGET <<<"$(target/release/imgdiff --version)"
TARGET="${TARGET#(}"
TARGET="${TARGET%)}"
echo "=== packaging imgdiff $VERSION ($TARGET, $MODDIR) ===" >&2

# web の導入導線が別の tag を指したまま発版すると、install.sh は**無言で古い版を配り続ける**
# （利用者側には何のエラーも出ない）。発版のたびに必ず通るここで止める。
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

OUT="target/macos-package"
BUNDLE="$OUT/imgdiff"
rm -rf "$OUT"
mkdir -p "$BUNDLE/bin" "$BUNDLE/lib/$MODDIR"

# dylibbundler の -x は **その場で書き換える**。必ず束の中の複製に対して走らせる
# （brew のファイルを直接指すと Homebrew の導入物を壊す）。
cp target/release/imgdiff "$BUNDLE/bin/"
for m in "${MODULES[@]}"; do
  cp "$VIPS_LIB/$MODDIR/$m" "$BUNDLE/lib/$MODDIR/"
done
chmod u+w "$BUNDLE/bin/imgdiff" "$BUNDLE/lib/$MODDIR"/*.dylib

# 依存 dylib の閉包を集めて install name を @executable_path/../lib へ書き換え、ad-hoc 署名する。
# モジュールは imgdiff のプロセスへ dlopen されるので @executable_path は常に bin/ を指す＝ lib/ を共有できる。
# /usr/lib と /System/Library（libSystem, libc++, Security.framework 等）は対象外＝ OS 標準を使う。
# </dev/null: 依存を解決できないとき対話で待ち続けるのを防ぐ（その場で失敗させる）。
FIX_ARGS=(-x "$BUNDLE/bin/imgdiff")
for m in "${MODULES[@]}"; do
  FIX_ARGS+=(-x "$BUNDLE/lib/$MODDIR/$m")
done
echo "=== dylibbundler ===" >&2
dylibbundler "${FIX_ARGS[@]}" \
  -b -cd -of \
  -d "$BUNDLE/lib" \
  -p '@executable_path/../lib/' \
  -s "$BREW_PREFIX/lib" </dev/null >&2

# 以降の検査・署名は束の中の Mach-O 全部が対象。一度だけ集める。
MACHO=()
while IFS= read -r -d '' f; do MACHO+=("$f"); done \
  < <(find "$BUNDLE" -type f \( -name '*.dylib' -o -name imgdiff \) -print0)

rpaths() { otool -l "$1" | awk '/LC_RPATH/{r=1} r&&/ path /{print $2; r=0}'; }

# dylibbundler は複数の入口から到達した dylib に `@executable_path/../lib/` を重ねて足すことがあり、
# **LC_RPATH が重複した Mach-O は dyld が読み込みを拒否する**（"duplicate LC_RPATH"）。
# 元から同じ rpath を持つ openexr 系などで起きるので、重複を 1 つに削って署名し直す。
# （書き換え後の参照はすべて `@executable_path/../lib/<name>` の直指定で `@rpath/` は残らないが、
#   rpath を 1 つ残すのは無害なので消し過ぎずに重複だけ潰す。）
echo "=== dedupe LC_RPATH ===" >&2
for f in "${MACHO[@]}"; do
  changed=0
  while read -r n p; do
    # LC_RPATH を 1 つも持たない Mach-O では空行が来る（`[: : integer expected` になるので弾く）。
    [ -n "$n" ] || continue
    while [ "$n" -gt 1 ]; do
      install_name_tool -delete_rpath "$p" "$f"
      echo "  $f: 重複 rpath を削除 ($p)" >&2
      n=$((n - 1))
      changed=1
    done
  done <<<"$(rpaths "$f" | sort | uniq -c)"
  # install_name_tool は既存の署名を無効化するので、削った物だけ最後に 1 回署名し直す。
  if [ "$changed" -eq 1 ]; then
    codesign -f -s - "$f" >/dev/null
  fi
done

echo "=== self-check ===" >&2
# 0) LC_RPATH に重複が無いこと（あると dyld がそのファイルの読み込みを拒否する）。
for f in "${MACHO[@]}"; do
  dup="$(rpaths "$f" | sort | uniq -d)"
  if [ -n "$dup" ]; then
    echo "NG: LC_RPATH が重複しています: $f ($dup)" >&2
    exit 1
  fi
done
# 1) 外部（brew / ホームディレクトリ）への参照が 1 つも残っていないこと。
leaks="$(otool -L "${MACHO[@]}" | grep -E "$BREW_PREFIX|/Users/" || true)"
if [ -n "$leaks" ]; then
  echo "NG: 外部ライブラリへの参照が残っています:" >&2
  echo "$leaks" >&2
  exit 1
fi
# 2) symlink が混ざっていないこと（zip 展開側は実体しか想定していない）。
if find "$BUNDLE" -type l | grep -q .; then
  echo "NG: 束に symlink が含まれています" >&2
  find "$BUNDLE" -type l >&2
  exit 1
fi
# 3) すべての Mach-O が有効な署名を持つこと（Apple Silicon では未署名だと起動できない）。
codesign -v --strict "${MACHO[@]}" >&2
# 4) brew 側を壊していないこと（dylibbundler の -x は in-place なので、指定ミスの保険）。
for m in "${MODULES[@]}"; do
  codesign -v --strict "$VIPS_LIB/$MODDIR/$m" >&2
done
echo "同梱 dylib: $((${#MACHO[@]} - 1)) / bundle: $(du -sh "$BUNDLE" | cut -f1)" >&2

# zip。--keepParent で先頭コンポーネントが imgdiff/ になる（update.rs::swap_in_place の前提）。
# --sequesterRsrc は付けない（__MACOSX/ が生える）。
ZIP_NAME="imgdiff-$VERSION-$TARGET.zip"
ditto -c -k --keepParent "$BUNDLE" "$OUT/$ZIP_NAME"

# zip に unix の実行権限が乗っているか（乗っていないと update 後に起動できない）。
# 一覧は変数へ取る（`| grep -q` だと grep が先に閉じて unzip が SIGPIPE で落ち、pipefail が誤検知する）。
ZLIST="$(unzip -Z -l "$OUT/$ZIP_NAME")"
if ! grep -qE '^-rwxr-xr-x.*imgdiff/bin/imgdiff' <<<"$ZLIST"; then
  echo "NG: zip に実行権限が保存されていません" >&2
  grep 'bin/imgdiff' <<<"$ZLIST" >&2
  exit 1
fi

bash scripts/emit-manifest-fragment.sh "$OUT" "$ZIP_NAME" "$VERSION" "$TARGET"

echo "$OUT/$ZIP_NAME"
