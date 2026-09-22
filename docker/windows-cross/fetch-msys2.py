#!/usr/bin/env python3
"""MSYS2 の mingw64 パッケージを依存ごと取ってきて、交叉編譯に使える前置きへ展開する。

**なぜ MSYS2 なのか。** libvips の公式 Windows 配布物（build-win64-mxe の zip）でも編譯自体は
通るが、あちらの libheif は **HEVC の復号器を組み込んでいない**（実測: `Support for this
compression format has not been built in`）。既に検証済みの Windows パッケージは MSYS2 で
作った物なので、**同じ出所の二進を使う**方が挙動も揃う（版も mac と同じ 8.18.6）。

パッケージは `.pkg.tar.zst` ＝ ただのアーカイブなので、Windows は要らない。
"""

from __future__ import annotations

import hashlib
import io
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

REPO = "https://repo.msys2.org/mingw/mingw64"
DB = f"{REPO}/mingw64.db"
PREFIX = "mingw-w64-x86_64-"

# ここから依存を辿る。**libheif は libvips の optdepend** なので明示で足す（heif モジュールの本体）。
# jxl も同じく optdepend。CLI の走査対象拡張子に jxl は無いので入れない（SPEC §5.4）。
ROOTS = [f"{PREFIX}libvips", f"{PREFIX}libheif"]

# **版を固定する。** `mingw64.db` は生きている索引なので、放っておくと「その日の最新」を拾う ——
# mac 側と版がずれれば、同じ画像から違う画素が出て SPEC §1 の parity が黙って崩れる。
# ここで拒めば、上流が上がったときに**ビルドが落ちて**気づける（気づかないまま配るのが最悪）。
# 上げるときは実測し直して（`scripts/smoke-windows-cross.sh`）この表を書き換える。
PINNED = {
    f"{PREFIX}libvips": "8.18.6-1",
    f"{PREFIX}libheif": "1.23.5-1",
}


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as r:  # noqa: S310 - 固定の https 先
        return r.read()


def untar_zst(blob: bytes) -> tarfile.TarFile:
    """zstd を解いて tar として開く。

    **`tarfile` に任せない** —— zstd を直接読めるのは Python 3.14 からで、
    容器の Debian は 3.13。どちらでも同じに動くよう `zstd -dc` を通す。
    """
    plain = subprocess.run(  # noqa: S603 - 固定のコマンド
        ["zstd", "-dc"], input=blob, capture_output=True, check=True
    ).stdout
    return tarfile.open(fileobj=io.BytesIO(plain))


def load_db() -> tuple[dict[str, dict[str, list[str]]], dict[str, str]]:
    """`mingw64.db` を読み、{パッケージ名: 各節} と {提供名: 実体のパッケージ名} を返す。"""
    with untar_zst(fetch(DB)) as t:
        packages: dict[str, dict[str, list[str]]] = {}
        provides: dict[str, str] = {}
        for member in t.getmembers():
            if not member.name.endswith("/desc"):
                continue
            f = t.extractfile(member)
            if f is None:
                continue
            fields: dict[str, list[str]] = {}
            key = None
            for line in f.read().decode().splitlines():
                if line.startswith("%") and line.endswith("%"):
                    key = line.strip("%")
                    fields[key] = []
                elif line and key:
                    fields[key].append(line)
            name = fields["NAME"][0]
            packages[name] = fields
            provides[name] = name
            for p in fields.get("PROVIDES", []):
                provides[bare(p)] = name
    return packages, provides


def bare(dep: str) -> str:
    """依存の版の縛り（`foo=1.2` / `foo>=1.2`）を落として名前だけにする。"""
    for op in ("=", ">", "<"):
        dep = dep.split(op)[0]
    return dep.strip()


def closure(packages, provides, roots: list[str]) -> list[str]:
    seen: set[str] = set()
    queue = list(roots)
    while queue:
        want = bare(queue.pop())
        name = provides.get(want)
        if name is None:
            # **飛ばさない。** 依存名が変わった / PROVIDES を取り違えたときに、
            # 「ビルドは通るのに DLL が足りない zip」が出来るのが一番たちが悪い。
            raise SystemExit(f"依存 {want} を解決できない（索引の形が変わった可能性）")
        if name in seen:
            continue
        seen.add(name)
        queue.extend(packages[name].get("DEPENDS", []))
    return sorted(seen)


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/win")
    packages, provides = load_db()
    names = closure(packages, provides, ROOTS)
    for pkg, want_version in PINNED.items():
        got = packages[pkg]["VERSION"][0]
        if got != want_version:
            raise SystemExit(
                f"{pkg} が {got}（固定は {want_version}）。"
                "上流が上がっている —— 実測し直してから PINNED を書き換えること。"
            )
    print(f"=== {len(names)} パッケージを展開する ===", file=sys.stderr)
    out.mkdir(parents=True, exist_ok=True)
    for name in names:
        fields = packages[name]
        filename = fields["FILENAME"][0]
        blob = fetch(f"{REPO}/{filename}")
        # **必ず照合する。** 取得元が差し替わっても気づけるように。
        want = fields["SHA256SUM"][0]
        got = hashlib.sha256(blob).hexdigest()
        if got != want:
            print(f"!! {filename}: sha256 が合わない（{got} != {want}）", file=sys.stderr)
            return 1
        with untar_zst(blob) as t:
            for member in t.getmembers():
                # `mingw64/` の下だけを、その前置きを落として展開する
                # （`.BUILDINFO` 等の制御ファイルは書庫の根に在るのでここで落ちる）。
                rel = member.name.removeprefix("mingw64/")
                if rel == member.name or not rel:
                    continue
                # **link は飛ばす。** MSYS2 の一部パッケージは同じ exe を hardlink で二重に置くが、
                # 欲しいのは DLL と開発ファイルだけで、link 先が同じ書庫に無いこともある。
                if member.islnk() or member.issym():
                    continue
                f = t.extractfile(member)
                if f is None:
                    continue  # ディレクトリ項目。下の mkdir が要るぶんを作るので落として良い。
                dst = out / rel
                # **出力先が `out` の外へ出ないこと**を確かめる（`..` を含む項目・書庫の細工）。
                if not dst.resolve().is_relative_to(out.resolve()):
                    raise SystemExit(f"展開先が外へ出る: {member.name}")
                dst.parent.mkdir(parents=True, exist_ok=True)
                with dst.open("wb") as w:
                    shutil.copyfileobj(f, w)
    print(f"=== 展開先 {out} ===", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
