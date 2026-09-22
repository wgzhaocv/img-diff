# Windows 版 imgdiff を**交叉編譯**するための容器。
#
# **わざと arm64（宿主と同じ）で建てる。** 交叉編譯は宿主の架構を問わないので、
# ここを amd64 にすると Rosetta で全部が遅くなるだけで何の得も無い。
# amd64 が要るのは出来た `.exe` を wine で動かす瞬間だけ（scripts/smoke-windows-cross.sh）。
#
# libvips は公式の Windows 版（MXE で建てた物）をそのまま使う。mac 側と**同じ 8.18.6**
# —— 版が違うと同じ画像で違う画素が出かねない（SPEC §1）。
FROM debian:trixie-slim

# mingw-w64 = 交叉編譯器。pkg-config = build.rs の `pkg_config::probe("vips")` が使う。
# gcc / libc6-dev は**宿主向け**（build.rs 等のビルドスクリプトは宿主で走る）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip zip xz-utils zstd \
      mingw-w64 pkg-config make python3 \
      gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# --- libvips（Windows 版）-------------------------------------------------------
# **MSYS2 の mingw64 パッケージを使う。** libvips 公式の Windows 配布物（build-win64-mxe の zip）
# でも編譯は通るが、あちらの libheif には **HEVC の復号器が入っていない**
# （実測: `Support for this compression format has not been built in`）。
# 既に検証済みの Windows パッケージは MSYS2 製なので、同じ出所の二進に揃える。版は mac と同じ 8.18.6。
COPY fetch-msys2.py /usr/local/bin/fetch-msys2.py
RUN python3 /usr/local/bin/fetch-msys2.py /opt/vips

# **`.pc` の prefix を書き換える。** MSYS2 の `.pc` は `/mingw64` を指しているので、
# そのままだと pkg-config が在りもしない場所を見る。
RUN sed -i "s|^prefix=/mingw64|prefix=/opt/vips|" /opt/vips/lib/pkgconfig/*.pc

ENV PKG_CONFIG_PATH=/opt/vips/lib/pkgconfig \
    PKG_CONFIG_ALLOW_CROSS=1 \
    CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
    VIPS_ROOT=/opt/vips \
    CARGO_HOME=/opt/cargo \
    RUSTUP_HOME=/opt/rustup \
    PATH=/opt/cargo/bin:$PATH

# --- Rust ----------------------------------------------------------------------
ARG RUST_VERSION=1.98.1
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path \
      --profile minimal --default-toolchain "${RUST_VERSION}" \
      --target x86_64-pc-windows-gnu

WORKDIR /src
