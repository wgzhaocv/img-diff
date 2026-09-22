#!/usr/bin/env bash
# `smoke-windows-cross.sh` が amd64 + wine の容器の中で走らせる本体。単体では使わない。
set -euo pipefail
cd "$(dirname "$0")/.."

ZIP="$(ls target/win-package/imgdiff-*-x86_64-pc-windows-gnu.zip | head -1)"
WORK="$(mktemp -d)"
unzip -q "$ZIP" -d "$WORK"
EXE="$WORK/imgdiff/bin/imgdiff.exe"
[ -f "$EXE" ] || { echo "zip の中に imgdiff/bin/imgdiff.exe が無い" >&2; exit 1; }

run() { wine "$EXE" "$@" 2>/dev/null; }

echo "--- 1. 起動と名乗り ---"
VERSION_LINE="$(run --version | tr -d '\r')"
echo "$VERSION_LINE"
# packaging が付けた名前（zip のファイル名）と、実行ファイル自身の名乗りが一致すること。
WANT_VERSION="$(basename "$ZIP" | sed 's/^imgdiff-//; s/-x86_64-pc-windows-gnu\.zip$//')"
[ "$VERSION_LINE" = "imgdiff $WANT_VERSION (x86_64-pc-windows-gnu)" ] || {
  echo "名乗りが zip の名前と食い違う（期待: imgdiff $WANT_VERSION (x86_64-pc-windows-gnu)）" >&2
  exit 1
}

echo "--- 2. dHash が golden と一致するか（tests/golden.json）---"
run scan tests/fixtures -o json --full > "$WORK/scan.json"
python3 - "$WORK/scan.json" <<'PY'
import json, sys
scan = json.load(open(sys.argv[1]))
golden = json.load(open("tests/golden.json"))
got = {im["path"]: im for im in scan["images"]}
bad = 0
for want in golden["images"]:
    im = got.get(want["file"])
    if im is None:
        print(f"  {want['file']}: 走査に出てこない"); bad += 1; continue
    ok = im["phash"] == want["dhash"] and im["width"] == want["width"] and im["height"] == want["height"]
    print(f"  {'OK ' if ok else 'NG '} {want['file']} {im['width']}x{im['height']} {im['phash']}")
    if not ok:
        print(f"      期待: {want['width']}x{want['height']} {want['dhash']}"); bad += 1
sys.exit(1 if bad else 0)
PY

echo "--- 3. compare（同一ファイル）---"
run compare tests/fixtures/photo.jpg tests/fixtures/photo.jpg -o json |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print("  ssim", d["ssim"], "/ shaEqual", d["shaEqual"]); sys.exit(0 if d["shaEqual"] and d["ssim"]==1.0 else 1)'

echo "--- 4. HEVC の HEIC が読めるか（vips-heif モジュール + libde265 を同梱できているか）---"
run compare apps/website/tests/fixtures/sample.heic apps/website/tests/fixtures/sample.heic -o json |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print("  ", d["a"]["width"], "x", d["a"]["height"], "ssim", d["ssim"]); sys.exit(0 if d["a"]["width"]>0 else 1)'

rm -rf "$WORK"
echo "=== 煙試験すべて通過 ==="
