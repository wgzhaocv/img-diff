//! グループ化（`SPEC.md §5`）。union-find と keeper 選定。

use crate::report::{DupGroup, ImageRecord, Strictness};

/// 索引済み画像を厳密度に応じてグループ化する。SPEC.md §5。
/// - exact/pixel: 同一ハッシュで完全グループ化（auto_deletable = true）。
/// - perceptual: ハミング ≤ threshold を辺に union-find（auto_deletable = false, max_hamming 付与）。
pub fn group(
    _images: &[ImageRecord],
    _strictness: Strictness,
    _threshold: Option<u32>,
) -> Vec<DupGroup> {
    todo!("SPEC.md §5: ハッシュ別グループ化 / union-find と keeper 選定")
}
