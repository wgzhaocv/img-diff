//! 2 枚比較のスコア（`SPEC.md §3`）。いずれも寸法一致が前提。

/// 白平坦化後 RGBA 2 枚の画素オフセット `i`（= p·4）で、R/G/B いずれかのチャンネル差が
/// `> tolerance` か（= 差分画素か）を返す。`pixel_diff_ratio`（差分割合）と `diff::highlight`
/// （品紅ハイライト）がこの 1 述語を共有し、両者が構造的に一致することを保証する
/// （alpha は白平坦化済みのため除外）。SPEC.md §3。
#[inline]
pub(crate) fn pixel_differs(a: &[u8], b: &[u8], i: usize, tolerance: u8) -> bool {
    a[i].abs_diff(b[i]) > tolerance
        || a[i + 1].abs_diff(b[i + 1]) > tolerance
        || a[i + 2].abs_diff(b[i + 2]) > tolerance
}

/// sRGB RGBA（白平坦化後）の 2 枚から、差分ピクセル割合 0..1 を返す。
/// 各ピクセルの R/G/B いずれかのチャンネル差 `> tolerance` を差分とみなす（alpha は平坦化済みのため除外）。
/// SPEC.md §3。
pub fn pixel_diff_ratio(a: &[u8], b: &[u8], tolerance: u8) -> f64 {
    // 前提は同寸法（= 同長）。安全側に短い方の画素数で評価する。
    let pixels = a.len().min(b.len()) / 4;
    if pixels == 0 {
        return 0.0;
    }
    let mut diff = 0usize;
    for p in 0..pixels {
        if pixel_differs(a, b, p * 4, tolerance) {
            diff += 1;
        }
    }
    diff as f64 / pixels as f64
}

/// グレースケール（1 byte/px、行優先、len = w*h）の矩形領域の SSIM を計算する内部関数。
fn ssim_window(
    a: &[u8],
    b: &[u8],
    stride: usize,
    x0: usize,
    y0: usize,
    ww: usize,
    wh: usize,
) -> f64 {
    let (mut sx, mut sy, mut sxx, mut syy, mut sxy) = (0.0f64, 0.0, 0.0, 0.0, 0.0);
    for dy in 0..wh {
        let row = (y0 + dy) * stride;
        for dx in 0..ww {
            let idx = row + x0 + dx;
            let x = a[idx] as f64;
            let y = b[idx] as f64;
            sx += x;
            sy += y;
            sxx += x * x;
            syy += y * y;
            sxy += x * y;
        }
    }
    let n = (ww * wh) as f64;
    let mux = sx / n;
    let muy = sy / n;
    let vx = sxx / n - mux * mux; // 母分散（N で割る）
    let vy = syy / n - muy * muy;
    let cxy = sxy / n - mux * muy;
    let l = 255.0;
    let c1 = (0.01 * l) * (0.01 * l);
    let c2 = (0.03 * l) * (0.03 * l);
    ((2.0 * mux * muy + c1) * (2.0 * cxy + c2)) / ((mux * mux + muy * muy + c1) * (vx + vy + c2))
}

/// グレースケール 2 枚（同寸法）の SSIM 0..1（1 = 同一）。
/// 窓 8x8 一様・**スライド step=1・完全窓のみ**、L=255、K1=0.01、K2=0.03、全窓平均。
/// w か h が 8 未満のときは画像全体を 1 窓として扱う。SPEC.md §3。
pub fn ssim(a: &[u8], b: &[u8], width: u32, height: u32) -> f64 {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return 1.0;
    }
    let n = w * h;
    if a.len() < n || b.len() < n {
        return f64::NAN; // 前提違反（寸法とバッファ長の不一致）
    }
    let win = 8usize;
    let raw = if w < win || h < win {
        ssim_window(a, b, w, 0, 0, w, h)
    } else {
        let mut total = 0.0f64;
        let mut count = 0usize;
        for y0 in 0..=(h - win) {
            for x0 in 0..=(w - win) {
                total += ssim_window(a, b, w, x0, y0, win, win);
                count += 1;
            }
        }
        total / count as f64
    };
    // SSIM の数学的範囲は [-1,1]（反相関で負）。本 API は SPEC §3 の通り 0..1 に丸める。
    raw.clamp(0.0, 1.0)
}

/// PSNR(dB)。RGBA（白平坦化後）2 枚の **R/G/B 上**の MSE から算出（alpha は除外）。
/// MSE=0（同一）は ∞ のため 100 で打ち切る。SPEC.md §3（pixelDiffRatio と同じ RGB バイト）。
pub fn psnr(a: &[u8], b: &[u8]) -> f64 {
    let pixels = a.len().min(b.len()) / 4;
    if pixels == 0 {
        return 100.0; // 空 = 同一とみなす
    }
    // R/G/B のみ二乗誤差を逐次加算（左畳み込み＝順序固定で決定的）。alpha はスキップ。
    let mut se = 0.0f64;
    for p in 0..pixels {
        let i = p * 4;
        for c in 0..3 {
            let d = a[i + c] as f64 - b[i + c] as f64;
            se += d * d;
        }
    }
    let mse = se / (pixels * 3) as f64;
    if mse == 0.0 {
        return 100.0;
    }
    (10.0 * (255.0 * 255.0 / mse).log10()).min(100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixel_diff_identical_is_zero() {
        let a = vec![10, 20, 30, 255, 40, 50, 60, 255];
        assert_eq!(pixel_diff_ratio(&a, &a, 0), 0.0);
    }

    #[test]
    fn pixel_diff_all_different_is_one() {
        let a = vec![0u8; 8]; // 2 px
        let b = vec![255u8; 8];
        assert_eq!(pixel_diff_ratio(&a, &b, 0), 1.0);
    }

    #[test]
    fn pixel_diff_tolerance_boundary() {
        // 1 px、R が 5 違う。tolerance=5 は差分でない（5>5 が偽）、tolerance=4 は差分。
        let a = vec![100, 0, 0, 255];
        let b = vec![105, 0, 0, 255];
        assert_eq!(pixel_diff_ratio(&a, &b, 5), 0.0);
        assert_eq!(pixel_diff_ratio(&a, &b, 4), 1.0);
    }

    #[test]
    fn ssim_identical_is_one() {
        // 非一様（グラデ）でも同一なら 1.0。
        let mut g = vec![0u8; 16 * 16];
        for (i, px) in g.iter_mut().enumerate() {
            *px = (i % 256) as u8;
        }
        assert!((ssim(&g, &g, 16, 16) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn ssim_opposite_constants_is_near_zero() {
        // 全 0 と全 255（最大に異なる一様画像）。分散 0 なので SSIM = c1/(255²+c1) ≈ 0.0001。
        let a = vec![0u8; 16 * 16];
        let b = vec![255u8; 16 * 16];
        assert!(ssim(&a, &b, 16, 16) < 0.001);
    }

    #[test]
    fn ssim_inverted_checkerboard_is_clamped_to_zero() {
        // 8x8 市松 vs 反転市松は SSIM ≈ -0.996（反相関）。0..1 に丸めて 0 を返す。
        let mut a = vec![0u8; 8 * 8];
        let mut b = vec![0u8; 8 * 8];
        for y in 0..8 {
            for x in 0..8 {
                let on = (x + y) % 2 == 0;
                a[y * 8 + x] = if on { 0 } else { 255 };
                b[y * 8 + x] = if on { 255 } else { 0 };
            }
        }
        assert_eq!(ssim(&a, &b, 8, 8), 0.0);
    }

    #[test]
    fn psnr_identical_is_capped_100() {
        let a = vec![10, 20, 30, 255, 40, 50, 60, 255]; // 2 px RGBA
        assert_eq!(psnr(&a, &a), 100.0);
    }

    #[test]
    fn psnr_unit_diff_is_known_db() {
        // 8 px・R/G/B が一様に 1 違う → MSE=1 → 10·log10(255²) ≈ 48.131 dB。
        let a = vec![100u8; 32];
        let b = vec![101u8; 32];
        assert!((psnr(&a, &b) - 48.1311).abs() < 0.001);
    }

    #[test]
    fn psnr_excludes_alpha() {
        // RGB 同一・alpha のみ相違 → MSE=0 → 100dB（alpha 除外の検証）。
        let a = vec![10, 20, 30, 0];
        let b = vec![10, 20, 30, 255];
        assert_eq!(psnr(&a, &b), 100.0);
    }
}
