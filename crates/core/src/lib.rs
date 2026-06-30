//! img-diff のコアロジック（デコード無関）。CLI（原生 libvips）と wasm（web の wasm-vips）が共有する。
//! デコードと前処理（autorotate / 白平坦化 / sRGB）は呼び出し側が行い、ここは RGBA を受けて処理する。
//! 仕様の正本は `packages/schema/SPEC.md`。

pub mod cluster;
pub mod compare;
pub mod hash;
pub mod report;
