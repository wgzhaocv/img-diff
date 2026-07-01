//! 差分ハイライト画像の生成（`SPEC.md §4`）。純ピクセル演算のみ（PNG 符号化は呼び出し側）。
//! CLI と wasm が共有する（デコード無関）。

use crate::{compare, preprocess};

/// 白平坦化後 RGBA 2 枚（同寸法前提）から、差分ハイライト RGBA（4 byte/px・行優先）を返す。
/// ベースは A を Rec.601 グレー化し白側へ淡化（round(gray·0.4 + 255·0.6)）した無彩色。
/// 各ピクセルの R/G/B いずれかの差が `> tolerance` の箇所を品紅 (255,0,255) で塗る
/// （差分判定は `compare::pixel_differs` を共有・alpha は平坦化済みのため除外）。
/// これにより品紅ピクセル数 = `pixel_diff_ratio · 総px` が厳密に成り立つ。
/// 返り値長は min(a,b) の画素数 ×4（安全側に短い方で評価）。
pub fn highlight(a: &[u8], b: &[u8], tolerance: u8) -> Vec<u8> {
    let pixels = a.len().min(b.len()) / 4;
    let mut out = Vec::with_capacity(pixels * 4);
    for p in 0..pixels {
        let i = p * 4;
        if compare::pixel_differs(a, b, i, tolerance) {
            out.extend_from_slice(&[255, 0, 255, 255]); // 品紅（差分）
        } else {
            // ベースは A の Rec.601 グレー（式は preprocess と単一ソース）を白側へ淡化:
            // round(gray·0.4 + 255·0.6) = (gray·2 + 765 + 2) / 5 の整数演算。
            let gray = preprocess::gray_rec601_px(a[i], a[i + 1], a[i + 2]);
            let faded = ((gray as u32 * 2 + 255 * 3 + 2) / 5) as u8;
            out.extend_from_slice(&[faded, faded, faded, 255]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compare::pixel_diff_ratio;

    #[test]
    fn identical_has_no_magenta_and_faded_base() {
        // 白px と 黒px。同一同士なので差分ゼロ、ベースは faded グレー（白→255・黒→153）。
        let a = vec![255, 255, 255, 255, 0, 0, 0, 255];
        let out = highlight(&a, &a, 0);
        assert_eq!(&out[0..4], &[255, 255, 255, 255]);
        assert_eq!(&out[4..8], &[153, 153, 153, 255]);
    }

    #[test]
    fn differing_pixel_is_magenta() {
        // 2px。2px 目の R だけ相違 → その画素のみ品紅、1px 目は faded グレー。
        let a = vec![10, 20, 30, 255, 40, 50, 60, 255];
        let b = vec![10, 20, 30, 255, 99, 50, 60, 255];
        let out = highlight(&a, &b, 0);
        assert_ne!(&out[0..4], &[255, 0, 255, 255]);
        assert_eq!(&out[4..8], &[255, 0, 255, 255]);
    }

    #[test]
    fn tolerance_boundary_matches_pixel_diff_ratio() {
        // R が 5 違う 1px。tol=5 は非差分（faded）、tol=4 は差分（品紅）。境界が pixel_diff_ratio と一致。
        let a = vec![100, 0, 0, 255];
        let b = vec![105, 0, 0, 255];
        assert_ne!(&highlight(&a, &b, 5)[0..4], &[255, 0, 255, 255]);
        assert_eq!(&highlight(&a, &b, 4)[0..4], &[255, 0, 255, 255]);
    }

    #[test]
    fn magenta_count_equals_pixel_diff_ratio() {
        // 4px 中 2px を相違させ、品紅数 == pixel_diff_ratio·総px を確認（整合性）。
        let a = vec![0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];
        let b = vec![0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255];
        let tol = 0;
        let out = highlight(&a, &b, tol);
        let pixels = a.len() / 4;
        let magenta = out
            .chunks_exact(4)
            .filter(|px| px[0] == 255 && px[1] == 0 && px[2] == 255)
            .count();
        let expected = (pixel_diff_ratio(&a, &b, tol) * pixels as f64).round() as usize;
        assert_eq!(magenta, expected);
        assert_eq!(magenta, 2);
    }
}
