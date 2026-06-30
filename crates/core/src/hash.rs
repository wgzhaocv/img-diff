//! dHash（知覚ハッシュ）。`SPEC.md §1` の手順をここに一本化する（CLI/wasm 共有）。

/// 9x8 グレースケール（行優先、各値 0..=255、計 72 個）から 64bit の dHash を計算する。
/// 各行で隣接ピクセル `left < right` を 1 ビット（行優先・MSB 先頭）。SPEC.md §1 step 7。
pub fn dhash_from_gray_9x8(_gray: &[u8; 72]) -> u64 {
    todo!("SPEC.md §1 step 7: 行ごとに隣接比較して 64bit を組み立てる")
}

/// RGBA8 バッファ（width*height*4。sRGB・alpha は白で平坦化済みが前提）を
/// 9x8 に固定 bilinear リサイズ → Rec.601 グレースケール → dHash。SPEC.md §1 step 5-8。
pub fn dhash_rgba(_rgba: &[u8], _width: u32, _height: u32) -> u64 {
    todo!("SPEC.md §1 step 5-6: 9x8 リサイズ→グレースケール→dhash_from_gray_9x8")
}

/// 64bit dHash を 16進16文字（MSB 先頭）に符号化する。SPEC.md §1 step 8。
pub fn to_hex(_hash: u64) -> String {
    todo!("SPEC.md §1 step 8")
}

/// 2 つの dHash のハミング距離（0..=64）。
pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}
