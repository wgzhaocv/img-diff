#!/usr/bin/env bash
# imgdiff の Windows 自己完結パッケージ（zip）を**交叉編譯**で作る。
#   imgdiff/bin/imgdiff.exe + libvips ランタイム DLL 閉包
# レイアウトは `scripts/package-windows.sh`（MSYS2 上で走らせる版）と**同じ**にする ——
# `crates/cli/src/update.rs` が zip の中身を `imgdiff/` 前置きで展開するので、ここが違うと自己更新が壊れる。
#
# **この台本は容器の中で走る**（`docker/windows-cross/Dockerfile`）。
# 外から使うときは `scripts/build-windows-cross.sh`。
#
# MSYS2 版との違いは 2 つだけ:
#   1. `objdump` も `zip` も Linux 側の物を使う（`cygpath` / `Compress-Archive` は無い）。
#   2. **版と target を実行ファイルに聞けない**（Linux では .exe を動かせない）。
#      target は編譯時に渡した triple そのもの、版は `cargo metadata` から採り、
#      **食い違っていないことは wine の煙試験が確かめる**（scripts/smoke-windows-cross.sh）。
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="x86_64-pc-windows-gnu"
VIPS_ROOT="${VIPS_ROOT:-/opt/vips}"
OBJDUMP="x86_64-w64-mingw32-objdump"
EXE="target/$TARGET/release/imgdiff.exe"

command -v "$OBJDUMP" >/dev/null || {
  echo "$OBJDUMP が無い（この台本は交叉編譯の容器の中で走らせる）" >&2
  exit 1
}
[ -d "$VIPS_ROOT/bin" ] || {
  echo "libvips（Windows 版）が $VIPS_ROOT に無い" >&2
  exit 1
}

echo "=== build (release, $TARGET) ===" >&2
cargo build --release -p imgdiff --target "$TARGET" >&2

VERSION="$(cargo metadata --no-deps --format-version 1 |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["packages"][0]["version"])')"
echo "=== packaging imgdiff $VERSION ($TARGET) ===" >&2

# web の導入導線が別の tag を指したまま発版すると、install.sh は**無言で古い版を配り続ける**。
# mac 版と同じ関門をここでも通す（片方の platform だけ発版することが在り得るので）。
bash scripts/check-release-pins.sh "$VERSION"

OUT="target/win-package"
BUNDLE="$OUT/imgdiff"
rm -rf "$OUT"
mkdir -p "$BUNDLE/bin"
cp "$EXE" "$BUNDLE/bin/"

# imgdiff.exe の DLL 依存を再帰的に集めて bin/ へ（objdump の BFS）。
# HEIF は**読み込み可能なモジュール**（`vips-heif.dll`）なので、libvips が既定の相対探索
# （`bin/../lib/vips-modules-8.18/`）で見つける場所へ置く —— MSYS2 の配置をそのまま模す。
# モジュール自身の依存（libheif / libde265 等）は exe と同じ `bin/` に置く
# ＝プロセスの exe ディレクトリは常に DLL 探索対象なので、`lib/` 下から解決できる。
# モジュールの置き場は配布物によって `lib/` だったり `bin/` だったりする（MSYS2 は `lib/`）。
# **見つからなかったら止める** —— HEIC が黙って読めない zip を出すのが一番たちが悪い。
HEIF_MODULE="$(ls "$VIPS_ROOT"/lib/vips-modules-*/vips-heif.dll \
  "$VIPS_ROOT"/bin/vips-modules-*/vips-heif.dll 2>/dev/null | head -1 || true)"
[ -n "$HEIF_MODULE" ] || {
  echo "vips-heif.dll が $VIPS_ROOT に無い（HEIC が読めない物を配ってしまう）" >&2
  exit 1
}
MODVER="$(basename "$(dirname "$HEIF_MODULE")")"
mkdir -p "$BUNDLE/lib/$MODVER"
cp "$HEIF_MODULE" "$BUNDLE/lib/$MODVER/"

declare -A seen
missing=()
queue=("$EXE" "$HEIF_MODULE")
while [ ${#queue[@]} -gt 0 ]; do
  cur="${queue[0]}"
  queue=("${queue[@]:1}")
  deps=$("$OBJDUMP" -p "$cur" 2>/dev/null | grep "DLL Name:" | sed 's/.*DLL Name: //' | tr -d '\r')
  for d in $deps; do
    [ -n "${seen[$d]:-}" ] && continue
    if [ -f "$VIPS_ROOT/bin/$d" ]; then
      seen[$d]=1
      cp "$VIPS_ROOT/bin/$d" "$BUNDLE/bin/"
      queue+=("$VIPS_ROOT/bin/$d")
    else
      # Windows 同梱の DLL（kernel32 等）はここに来る。名前で判らないので、
      # **持って行かなかった物は全部並べて見せる** —— 黙って落とすと、動かない zip が出来る。
      case "$d" in
      *.dll) missing[${#missing[@]}]="$d" ;;
      esac
    fi
  done
done
echo "=== 同梱 DLL: ${#seen[@]} ===" >&2
echo "=== 同梱しなかった依存（Windows 側に在る前提）: $(printf '%s ' "${missing[@]}" | tr ' ' '\n' | sort -u | tr '\n' ' ')" >&2
echo "=== bundle: $(du -sh "$BUNDLE" | cut -f1) ===" >&2

# zip の**根は `imgdiff/`**（`update.rs` の ARCHIVE_ROOT）。`-r` で `$OUT` から相対に固める。
ZIP_NAME="imgdiff-$VERSION-$TARGET.zip"
(cd "$OUT" && zip -qr "$ZIP_NAME" imgdiff)

# 中身が期待の場所に入っていることを確かめる（`update.rs` はこの道で探す）。
# **`grep -q` にしない** —— `pipefail` 下で早々に閉じると `unzip` が SIGPIPE で落ち、
# 中身が正しいのに失敗になる（実際そうなった）。
if ! unzip -l "$OUT/$ZIP_NAME" | grep -F "imgdiff/bin/imgdiff.exe" >/dev/null; then
  echo "zip の中に imgdiff/bin/imgdiff.exe が無い" >&2
  exit 1
fi

# target ごとの manifest 断片。リリース用の manifest.json は merge-manifest.sh が全 target を束ねて作る
# （各 target が manifest.json を直接書くと、同じ release で後からアップロードした方が相手を消す）。
bash scripts/emit-manifest-fragment.sh "$OUT" "$ZIP_NAME" "$VERSION" "$TARGET"

echo "$OUT/$ZIP_NAME"
