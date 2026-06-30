//! 2 枚比較のスコア（`SPEC.md §3`）。いずれも寸法一致が前提。

/// sRGB RGBA（白平坦化後）の 2 枚から、差分ピクセル割合 0..1 を返す。
/// いずれかのチャンネル差 `> tolerance` を差分とみなす。SPEC.md §3。
pub fn pixel_diff_ratio(_a: &[u8], _b: &[u8], _tolerance: u8) -> f64 {
    todo!("SPEC.md §3: チャンネル差 > tolerance を差分としてカウント")
}

/// グレースケール 2 枚（同寸法）の SSIM 0..1（1 = 同一）。
/// 窓 8x8 一様、L=255、K1=0.01、K2=0.03、全窓平均。SPEC.md §3。
pub fn ssim(_a: &[u8], _b: &[u8], _width: u32, _height: u32) -> f64 {
    todo!("SPEC.md §3: 8x8 窓で SSIM を計算し平均")
}

/// PSNR(dB)。MSE=0（同一）は ∞ のため 100 で打ち切る。SPEC.md §3。
pub fn psnr(_a: &[u8], _b: &[u8]) -> f64 {
    todo!("SPEC.md §3: MSE から PSNR、100dB 上限")
}
