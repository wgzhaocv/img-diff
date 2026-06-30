//! dHash（知覚ハッシュ）。`SPEC.md §1` の手順をここに一本化する（CLI/wasm 共有）。

use image::{imageops::FilterType, ImageBuffer, Rgba};

/// 9x8 グレースケール（行優先、各値 0..=255、計 72 個）から 64bit の dHash を計算する。
/// 各行で隣接ピクセル `left < right` を 1 ビット（行優先・MSB 先頭）。SPEC.md §1 step 7。
pub fn dhash_from_gray_9x8(gray: &[u8; 72]) -> u64 {
    // 8 行 × 各行 8 比較 = 64bit。最初の比較（行0 列0<列1）を最上位ビットに置く。
    let mut hash: u64 = 0;
    for row in 0..8 {
        let base = row * 9;
        for col in 0..8 {
            let bit = (gray[base + col] < gray[base + col + 1]) as u64;
            hash = (hash << 1) | bit;
        }
    }
    hash
}

/// RGBA8 バッファ（width*height*4。sRGB・alpha は白で平坦化済みが前提）を
/// 9x8 に固定 linear リサイズ → Rec.601 グレースケール → dHash。SPEC.md §1 step 5-8。
pub fn dhash_rgba(rgba: &[u8], width: u32, height: u32) -> u64 {
    // 長さ不一致・寸法 0 は安全側に倒す（呼び出し側はデコード失敗として扱える）。
    if width == 0 || height == 0 || rgba.len() != (width as usize) * (height as usize) * 4 {
        return 0;
    }
    // 借用スライスをそのまま画像ビューにして 9x8 へ縮小（kernel=linear=Triangle）。
    let view: ImageBuffer<Rgba<u8>, &[u8]> = match ImageBuffer::from_raw(width, height, rgba) {
        Some(v) => v,
        None => return 0,
    };
    let small = image::imageops::resize(&view, 9, 8, FilterType::Triangle);

    // pixels() は行優先（y→x）。9x8 = 72 画素を Rec.601 でグレースケール化。
    let mut gray = [0u8; 72];
    for (i, px) in small.pixels().enumerate() {
        let [r, g, b, _a] = px.0;
        let y = 0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64;
        gray[i] = y.round() as u8;
    }
    dhash_from_gray_9x8(&gray)
}

/// 64bit dHash を 16進16文字（小文字・MSB 先頭）に符号化する。SPEC.md §1 step 8。
pub fn to_hex(hash: u64) -> String {
    format!("{hash:016x}")
}

/// 16進16文字を dHash(u64) に戻す。`to_hex` の逆。不正な文字列は None。
/// cluster が `ImageRecord.phash`（文字列）を u64 に戻すのに使う。
pub fn from_hex(hex: &str) -> Option<u64> {
    u64::from_str_radix(hex, 16).ok()
}

/// 2 つの dHash のハミング距離（0..=64）。
pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 各行が単調増加なら全ビット 1（= u64::MAX）。
    #[test]
    fn from_gray_all_increasing_is_all_ones() {
        let mut gray = [0u8; 72];
        for row in 0..8 {
            for col in 0..9 {
                gray[row * 9 + col] = col as u8; // 0,1,..,8（左 < 右が常に真）
            }
        }
        assert_eq!(dhash_from_gray_9x8(&gray), u64::MAX);
    }

    /// 各行が単調減少なら全ビット 0。
    #[test]
    fn from_gray_all_decreasing_is_zero() {
        let mut gray = [0u8; 72];
        for row in 0..8 {
            for col in 0..9 {
                gray[row * 9 + col] = (8 - col) as u8; // 8,7,..,0（左 < 右が常に偽）
            }
        }
        assert_eq!(dhash_from_gray_9x8(&gray), 0);
    }

    /// 行0の最初の比較だけ真 → 最上位ビットのみ立つ（MSB 先頭の検証）。
    #[test]
    fn from_gray_first_comparison_is_msb() {
        let mut gray = [0u8; 72];
        // 行0 = [0,1,1,1,1,1,1,1,1] → 比較は 1,0,0,0,0,0,0,0。他行は全 0。
        gray[1] = 1;
        for col in 2..9 {
            gray[col] = 1;
        }
        assert_eq!(dhash_from_gray_9x8(&gray), 0x8000_0000_0000_0000);
    }

    #[test]
    fn hex_roundtrip() {
        for h in [0u64, 1, 0x8000_0000_0000_0000, u64::MAX, 0x0123_4567_89ab_cdef] {
            assert_eq!(to_hex(h).len(), 16);
            assert_eq!(from_hex(&to_hex(h)), Some(h));
        }
        assert_eq!(to_hex(u64::MAX), "ffffffffffffffff");
        assert_eq!(to_hex(0x8000_0000_0000_0000), "8000000000000000");
        assert_eq!(from_hex("zzz"), None);
    }

    #[test]
    fn hamming_basics() {
        assert_eq!(hamming(0, 0), 0);
        assert_eq!(hamming(0, u64::MAX), 64);
        assert_eq!(hamming(0b1011, 0b0010), 2);
    }

    /// width*height*4 でないバッファや寸法 0 は 0 を返す。
    #[test]
    fn rgba_invalid_input_returns_zero() {
        assert_eq!(dhash_rgba(&[], 0, 0), 0);
        assert_eq!(dhash_rgba(&[0, 0, 0, 255], 2, 2), 0); // 長さ不足
    }

    /// 単色画像は縮小後も全画素同値 → 隣接比較が全て偽 → 0。
    #[test]
    fn rgba_solid_color_is_zero() {
        let (w, h) = (16u32, 16u32);
        // RGB=128・A=255 の単色（[128,128,128,255] の繰り返し）。
        let rgba: Vec<u8> = [128, 128, 128, 255]
            .iter()
            .copied()
            .cycle()
            .take((w * h * 4) as usize)
            .collect();
        assert_eq!(dhash_rgba(&rgba, w, h), 0);
    }

    /// 横グラデーション（左→右で増加）。各行が増加 → 全ビット 1。
    /// さらに別サイズで生成しても **同一 dHash**（強制 9x8 のスケール不変性）。
    #[test]
    fn rgba_horizontal_gradient_is_all_ones_and_scale_invariant() {
        fn gradient(w: u32, h: u32) -> Vec<u8> {
            let mut rgba = vec![0u8; (w * h * 4) as usize];
            for y in 0..h {
                for x in 0..w {
                    let v = (x * 255 / (w - 1)) as u8;
                    let i = ((y * w + x) * 4) as usize;
                    rgba[i] = v;
                    rgba[i + 1] = v;
                    rgba[i + 2] = v;
                    rgba[i + 3] = 255;
                }
            }
            rgba
        }
        let small = dhash_rgba(&gradient(90, 80), 90, 80);
        let large = dhash_rgba(&gradient(900, 800), 900, 800);
        assert_eq!(small, u64::MAX);
        assert_eq!(small, large, "強制 9x8 リサイズでスケール不変であること");
    }
}
