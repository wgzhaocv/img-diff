#!/usr/bin/env bash
# web と CLI が **同じ HEIC から同じ dHash を出すか**を確かめる。
#
# web は wasm-vips が HEVC を読めないぶんを libheif-js（libde265）で補っており、
# CLI は原生 libvips（libheif）で読む。**画素は完全一致しない**（実測: 最大差 11）ので、
# 一致を要求するのは dHash —— 9×8 への縮小で補間差はならされる、という前提そのものを検査する。
#
# 前提: 原生 vips（brew install vips）と node、それに imgdiff 本体。
# 使い方: bash scripts/check-heic-parity.sh [HEIC のパス]
set -euo pipefail
cd "$(dirname "$0")/.."

HEIC="${1:-apps/website/tests/fixtures/sample.heic}"
IMGDIFF="${IMGDIFF:-$HOME/.local/share/imgdiff/bin/imgdiff}"
[ -f "$HEIC" ] || { echo "NG: $HEIC が在りません" >&2; exit 1; }
command -v vips >/dev/null || { echo "NG: 原生 vips が要ります（brew install vips）" >&2; exit 1; }
[ -x "$IMGDIFF" ] || { echo "NG: imgdiff が $IMGDIFF に在りません（IMGDIFF= で指定可）" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) 原生 libvips 側（CLI と同じデコーダ）を PNG へ。
vips colourspace "$HEIC" "$TMP/n3.v" srgb
vips bandjoin_const "$TMP/n3.v" "$TMP/n4.v" 255
vips copy "$TMP/n4.v" "$TMP/native.png"

# 2) web 側（libheif-js）を PNG へ。**ブラウザと同じグルーを node から読む。**
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('$PWD/apps/website/package.json');
// **本番と同じ入口**を読む（bundle 版だとアプリが通らない経路を検査してしまう）。
const factory = require('libheif-js/libheif-wasm/libheif.js');
const wasmPath = require.resolve('libheif-js/libheif-wasm/libheif.wasm');
const libheif = await factory({ locateFile: () => wasmPath });
// Buffer.buffer は共有プールなので、必ずコピーしてから渡す。
const bytes = new Uint8Array(readFileSync('$HEIC'));
const image = new libheif.HeifDecoder().decode(bytes)[0];
const width = image.get_width(), height = image.get_height();
const out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
await new Promise((res, rej) => image.display(out, (r) => (r ? res(r) : rej(new Error('display 失敗')))));
writeFileSync('$TMP/wasm.raw', Buffer.from(out.data.buffer));
console.log(width + ' ' + height);
" > "$TMP/dims"
read -r W H < "$TMP/dims"
vips rawload "$TMP/wasm.raw" "$TMP/wasm.png" "$W" "$H" 4 --format uchar

# 3) dHash が一致するか（compare は hammingDistance を返す）。
RESULT="$("$IMGDIFF" compare "$TMP/native.png" "$TMP/wasm.png" -o json)"
HAMMING="$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hammingDistance"])')"
SSIM="$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(round(json.load(sys.stdin)["ssim"], 5))')"

echo "$HEIC: ${W}x${H} / hamming $HAMMING / SSIM $SSIM"
if [ "$HAMMING" != "0" ]; then
  echo "NG: dHash が一致しません（hamming $HAMMING）。SPEC §1 の前提が崩れています。" >&2
  exit 1
fi
echo "OK: 両端の dHash は一致（画素は一致しないが、縮小でならされる）"
