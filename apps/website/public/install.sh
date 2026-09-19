#!/usr/bin/env bash
# imgdiff macOS インストーラ。GitHub Releases から自己完結パッケージ(zip)を取得し、
# ~/.local/share/imgdiff へ展開、その bin をシェルの PATH に追加する。
# 同梱 dylib 込みなので Homebrew で libvips を入れる必要はない。
# 使い方:  curl -fsSL https://imgdiff.wgzhao.me/install.sh | bash
# 再実行で最新版へ入れ替え(update 代わり)にもなる。
#
# 対応: Apple Silicon (arm64) / macOS 26 以降。
#   ビルドに使う Homebrew のボトルが macOS 26 向けに焼かれているため、それより古い macOS では
#   dyld がライブラリの読み込みを拒否する。Intel Mac と古い macOS は cargo install を案内する。
set -euo pipefail

REPO='wgzhaocv/img-diff'
TARGET='aarch64-apple-darwin'
# 配布中の版。macOS 版が Windows 版より先行している間は pre-release なので、
# `releases/latest` ではなくタグを直接指す。**Windows 版が揃って正式リリースへ昇格したら
# BASE を https://github.com/$REPO/releases/latest/download に替えて TAG を消す。**
# （tag を固定したまま発版すると無言で古い版を配り続けるので、
#   scripts/package-macos.sh が「ここの tag == パッケージの版」を毎回検査して止める。）
TAG="${IMGDIFF_TAG:-v0.1.5}"
BASE="https://github.com/$REPO/releases/download/$TAG"
DEST_PARENT="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DEST_PARENT/imgdiff"   # zip の先頭が imgdiff/ なので親へ展開するとここになる
BIN_DIR="$DEST/bin"

die() { echo "エラー: $*" >&2; exit 1; }

# 対象外の環境。案内先は 1 つ（ソースビルド）なのでまとめて扱う。
unsupported() {
  cat >&2 <<EOF
エラー: $1
ソースからビルドしてください:
  brew install vips libheif
  cargo install --git https://github.com/$REPO imgdiff
EOF
  exit 1
}

# --- 環境の確認 ---------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "このスクリプトは macOS 専用です。"
[ "$(uname -m)" = "arm64" ] \
  || unsupported "プレビルドは Apple Silicon (arm64) のみです（このマシンは $(uname -m)）。"
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 26 ] \
  || unsupported "プレビルドは macOS 26 以降が必要です（このマシンは $(sw_vers -productVersion)）。"

echo "imgdiff をインストールします..."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- manifest から資産名と sha256 を引く --------------------------------------
# install.ps1 と `imgdiff update` も同じ manifest.json を読む。資産名をここで組み立て直すと
# 命名規則の写しが増えて、いつか必ず食い違う（版番号もここに書かずに済む）。
# jq は macOS に無いので awk で読む。1 行 1 オブジェクト（断片）でも jq が整形した複数行でも
# 効くように、行ごとに「キー: 値」を拾う状態機械にしてある。
curl -fsSL "$BASE/manifest.json" -o "$TMP/manifest.json" \
  || die "manifest の取得に失敗しました（$BASE/manifest.json）。"
FOUND="$(awk -v target="$TARGET" '
  function field(k,   re, f) {
    re = "\"" k "\"[ \t]*:[ \t]*\"[^\"]*\""
    if (!match($0, re)) return ""
    f = substr($0, RSTART, RLENGTH)
    sub(/^[^:]*:[ \t]*"/, "", f)
    sub(/"$/, "", f)
    return f
  }
  {
    # target 行を見たら「ここから先が自分の分か」を切り替える（asset/sha より必ず先に判定する）。
    t = field("target"); if (t != "") cur = (t == target)
    if (v == "") { x = field("version"); if (x != "") v = x }
    if (cur) {
      x = field("asset");  if (x != "") a = x
      x = field("sha256"); if (x != "") s = x
    }
  }
  END { if (a != "" && s != "") print v, a, s }
' "$TMP/manifest.json")"
[ -n "$FOUND" ] || die "manifest に $TARGET のエントリがありません（$BASE/manifest.json）。"
read -r VERSION ASSET SHA <<<"$FOUND"
echo "  版 $VERSION / 資産 $ASSET"

# --- ダウンロードと検証 -------------------------------------------------------
echo "  ダウンロード中..."
curl -fsSL "$BASE/$ASSET" -o "$TMP/$ASSET" || die "ダウンロードに失敗しました（$BASE/${ASSET}）。"
echo "$SHA  $TMP/$ASSET" | shasum -a 256 -c - >/dev/null \
  || die "sha256 が一致しません。中断しました。"
echo "  検証 OK (sha256)"

# --- 展開と入れ替え -----------------------------------------------------------
# **先に一時領域へ展開して健全性を確かめ、最後に入れ替える。** いきなり既存を消すと、
# 展開が途中で失敗した／アーカイブが壊れていたときに、動いていた導入ごと失う。
# 旧版はディレクトリごと退けてから消す（残すと、新版から消えた dylib が孤児として居座る）。
STAGE="$TMP/stage"
mkdir -p "$STAGE"
ditto -x -k "$TMP/$ASSET" "$STAGE"
[ -x "$STAGE/imgdiff/bin/imgdiff" ] \
  || die "展開結果が不正です（bin/imgdiff が見つかりません）。導入は変更していません。"

# curl 経由なら通常 quarantine 属性は付かないが、付いていると Gatekeeper に止められる。
# 未公証（Developer ID 署名なし）の配布物なので、念のため落としておく。冪等。
xattr -dr com.apple.quarantine "$STAGE/imgdiff" 2>/dev/null || true

mkdir -p "$DEST_PARENT"
BACKUP=""
if [ -d "$DEST" ]; then
  BACKUP="$DEST.old.$$"
  mv "$DEST" "$BACKUP"
fi
if ! mv "$STAGE/imgdiff" "$DEST"; then
  if [ -n "$BACKUP" ]; then
    mv "$BACKUP" "$DEST"
    die "入れ替えに失敗しました。元の導入を復旧しました。"
  fi
  die "入れ替えに失敗しました。"
fi
if [ -n "$BACKUP" ]; then
  rm -rf "$BACKUP"
fi

# --- PATH への追加 ------------------------------------------------------------
# install.ps1 の「ユーザ PATH に追加」と同じ方針。シンボリックリンクは張らない
# （PATH なら imgdiff 自身の同梱判定・update の差し替え先が素直に束の中を向く）。
case "${SHELL:-}" in
  */bash) PROFILE="$HOME/.bash_profile" ;;
  *)      PROFILE="$HOME/.zshrc" ;;
esac
if ! grep -Fqs "$BIN_DIR" "$PROFILE"; then
  printf '\n# imgdiff\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$PROFILE"
  echo "  PATH に追加: $BIN_DIR （${PROFILE}）"
fi

echo
echo "完了。imgdiff $VERSION を $DEST に導入しました。"
"$BIN_DIR/imgdiff" --version
echo "新しいターミナル（または source ${PROFILE}）で imgdiff が使えます。"
echo "使い方は  imgdiff --help  ／ AI 手順書は  imgdiff skill"
