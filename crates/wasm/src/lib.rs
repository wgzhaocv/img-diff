//! core を web（WebAssembly）向けに公開する薄いラッパ。
//! 実装時に wasm-bindgen を追加し、wasm-vips がデコードした RGBA を受けて core を呼ぶ。
//! 現状は構造のみ（未実装）。

pub use imgdiff_core as core;
