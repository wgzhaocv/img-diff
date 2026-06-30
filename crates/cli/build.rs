//! libvips を pkg-config でリンクする。
//! ビルド時に `PKG_CONFIG_PATH=C:\msys64\mingw64\lib\pkgconfig` と
//! `PATH` に `C:\msys64\mingw64\bin`（pkg-config.exe）を設定しておくこと（CLAUDE.md 参照）。
//! vips.pc が glib/gobject を要求するため、g_free / g_object_unref も同時にリンクされる。

fn main() {
    if let Err(e) = pkg_config::Config::new().probe("vips") {
        panic!(
            "libvips (pkg-config: vips) が見つかりません: {e}\n\
             PKG_CONFIG_PATH に C:\\msys64\\mingw64\\lib\\pkgconfig を、\
             PATH に C:\\msys64\\mingw64\\bin を設定してください。"
        );
    }
}
