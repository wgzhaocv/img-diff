//! 前処理（`SPEC.md §1` 手順 4）。デコード側（libvips / wasm-vips）が手順 1〜3
//! （デコード・autorotate・sRGB）まで行い、ここから core が確定的に処理する。

/// RGBA8（sRGB・straight alpha）を背景白(255,255,255)で平坦化する。SPEC.md §1 手順 4。
/// 各画素 `out_c = round((c·a + 255·(255−a)) / 255)`、alpha は 255 にする。
/// CLI / web 両端がこれを呼んでから sha256(ピクセル) / dHash / compare を計算する
/// （白合成を sRGB 空間で両端同一に行い決定性を担保）。
pub fn flatten_on_white(rgba: &mut [u8]) {
    for px in rgba.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a == 255 {
            continue; // 不透明はそのまま
        }
        for c in px.iter_mut().take(3) {
            *c = ((*c as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
        }
        px[3] = 255;
    }
}

/// 1 画素の Rec.601 グレー値（0..=255）。`to_gray_rec601` と `diff::highlight` が式を共有する。
#[inline]
pub fn gray_rec601_px(r: u8, g: u8, b: u8) -> u8 {
    (0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64).round() as u8
}

/// RGBA を Rec.601 グレースケール（1 byte/px、行優先）に変換する。
/// SSIM 等の全分解能グレースケール入力に使う（SPEC §1 手順 6 と同式・両端共有）。
pub fn to_gray_rec601(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .map(|px| gray_rec601_px(px[0], px[1], px[2]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gray_rec601_known_values() {
        // 白→255、黒→0、純赤→round(0.299·255)=76。
        let rgba = vec![255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255];
        assert_eq!(to_gray_rec601(&rgba), vec![255, 0, 76]);
    }

    #[test]
    fn opaque_unchanged() {
        let mut rgba = vec![10, 20, 30, 255, 40, 50, 60, 255];
        let before = rgba.clone();
        flatten_on_white(&mut rgba);
        assert_eq!(rgba, before);
    }

    #[test]
    fn fully_transparent_becomes_white() {
        let mut rgba = vec![10, 20, 30, 0];
        flatten_on_white(&mut rgba);
        assert_eq!(rgba, vec![255, 255, 255, 255]);
    }

    #[test]
    fn half_alpha_black_is_mid_gray() {
        // (0,0,0,128) を白に半合成 → round(255·127/255) = 127、alpha=255。
        let mut rgba = vec![0, 0, 0, 128];
        flatten_on_white(&mut rgba);
        assert_eq!(rgba, vec![127, 127, 127, 255]);
    }
}
