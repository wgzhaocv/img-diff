//! libvips を pkg-config でリンクし、ターゲット triple を実行ファイルへ埋め込む。
//!
//! 前提（OS ごと）:
//! - Windows(gnu): `PKG_CONFIG_PATH=C:\msys64\mingw64\lib\pkgconfig` と
//!   `PATH` に `C:\msys64\mingw64\bin`（pkg-config.exe）を設定しておく（CLAUDE.md 参照）。
//! - macOS: `brew install vips libheif` で入る。PKG_CONFIG_PATH の設定は通常不要。
//!
//! vips.pc が glib/gobject を要求するため、g_free / g_object_unref も同時にリンクされる。

fn main() {
    if let Err(e) = pkg_config::Config::new().probe("vips") {
        panic!(
            "libvips (pkg-config: vips) が見つかりません: {e}\n\
             Windows: PKG_CONFIG_PATH に C:\\msys64\\mingw64\\lib\\pkgconfig を、\
             PATH に C:\\msys64\\mingw64\\bin を設定してください。\n\
             macOS: brew install vips libheif を実行してください。"
        );
    }

    // 配布アーカイブの target 名（manifest.json の "target"）を実行ファイルへ埋め込む。
    // cargo が build script に渡す TARGET は **ターゲット** triple なのでクロスビルドでも追随し、
    // パッケージ用スクリプトが使う `rustc -vV` の host と同じ表記になる（両者が食い違わない）。
    let target = std::env::var("TARGET").expect("cargo が TARGET を渡していません");
    println!("cargo:rustc-env=IMGDIFF_TARGET={target}");
}
