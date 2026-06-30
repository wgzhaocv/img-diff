//! グループ化（`SPEC.md §5`）。union-find と keeper 選定。

use crate::hash;
use crate::report::{DupGroup, ImageRecord, Strictness};
use std::collections::HashMap;

/// perceptual の既定ハミング閾値（SPEC.md §2）。`group` に threshold=None で渡されたとき使う。
pub const DEFAULT_PERCEPTUAL_THRESHOLD: u32 = 10;

/// 単純な union-find（path compression + union by size）。
struct UnionFind {
    parent: Vec<usize>,
    size: Vec<usize>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
            size: vec![1; n],
        }
    }

    fn find(&mut self, x: usize) -> usize {
        let mut root = x;
        while self.parent[root] != root {
            root = self.parent[root];
        }
        // path compression（反復）
        let mut cur = x;
        while self.parent[cur] != root {
            let next = self.parent[cur];
            self.parent[cur] = root;
            cur = next;
        }
        root
    }

    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra == rb {
            return;
        }
        let (big, small) = if self.size[ra] >= self.size[rb] {
            (ra, rb)
        } else {
            (rb, ra)
        };
        self.parent[small] = big;
        self.size[big] += self.size[small];
    }
}

/// 索引済み画像を厳密度に応じてグループ化する。SPEC.md §5。
/// - exact/pixel: 同一ハッシュで完全グループ化（auto_deletable = true）。
/// - perceptual: ハミング ≤ threshold を辺に union-find（auto_deletable = false, max_hamming 付与）。
pub fn group(
    images: &[ImageRecord],
    strictness: Strictness,
    threshold: Option<u32>,
) -> Vec<DupGroup> {
    let raw: Vec<Vec<usize>> = match strictness {
        Strictness::Exact => group_by_key(images, |r| Some(r.sha256.as_str())),
        Strictness::Pixel => group_by_key(images, |r| r.pixel_sha256.as_deref()),
        Strictness::Perceptual => {
            group_perceptual(images, threshold.unwrap_or(DEFAULT_PERCEPTUAL_THRESHOLD))
        }
    };

    // メンバ ≥2 のみグループ化。
    let mut groups: Vec<DupGroup> = raw
        .into_iter()
        .filter(|m| m.len() >= 2)
        .map(|m| build_group(images, &m, strictness))
        .collect();

    // 決定的順序: 最小メンバ path 昇順で並べ、id を 0.. で振り直す。
    groups.sort_by(|x, y| x.members[0].cmp(&y.members[0]));
    for (i, g) in groups.iter_mut().enumerate() {
        g.id = i as u32;
    }
    groups
}

/// 文字列キー（None はスキップ）でインデックスをグループ化する。exact/pixel 用。O(N)。
fn group_by_key<'a>(
    images: &'a [ImageRecord],
    key: impl Fn(&'a ImageRecord) -> Option<&'a str>,
) -> Vec<Vec<usize>> {
    let mut map: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, r) in images.iter().enumerate() {
        if let Some(k) = key(r) {
            map.entry(k).or_default().push(i);
        }
    }
    map.into_values().collect()
}

/// perceptual の連結成分を返す。phash を持つ画像のみが対象。
/// ペア探索は O(N²) 総当たり。規模が大きくなったら multi-index hashing へ差し替える（SPEC §7）。
fn group_perceptual(images: &[ImageRecord], threshold: u32) -> Vec<Vec<usize>> {
    let hashed: Vec<(usize, u64)> = images
        .iter()
        .enumerate()
        .filter_map(|(i, r)| r.phash.as_deref().and_then(hash::from_hex).map(|h| (i, h)))
        .collect();

    let mut uf = UnionFind::new(images.len());
    for a in 0..hashed.len() {
        for b in (a + 1)..hashed.len() {
            if hash::hamming(hashed[a].1, hashed[b].1) <= threshold {
                uf.union(hashed[a].0, hashed[b].0);
            }
        }
    }

    let mut comp: HashMap<usize, Vec<usize>> = HashMap::new();
    for &(i, _) in &hashed {
        let root = uf.find(i);
        comp.entry(root).or_default().push(i);
    }
    comp.into_values().collect()
}

/// dHash 列の最大ペア間ハミング距離（上三角総当たり）。空・単一は 0。
fn max_pairwise_hamming(hs: &[u64]) -> u32 {
    let mut mx = 0u32;
    for a in 0..hs.len() {
        for b in (a + 1)..hs.len() {
            mx = mx.max(hash::hamming(hs[a], hs[b]));
        }
    }
    mx
}

/// メンバ集合 1 つから DupGroup を組み立てる（id は呼び出し側で振り直す）。
fn build_group(images: &[ImageRecord], members_idx: &[usize], strictness: Strictness) -> DupGroup {
    // メンバを path 昇順で安定化。
    let mut idx = members_idx.to_vec();
    idx.sort_by(|&a, &b| images[a].path.cmp(&images[b].path));

    // keeper: 最大解像度(w·h) → 最大 bytes → path 昇順（小さい path が勝つ）。
    let keeper_i = *idx
        .iter()
        .max_by(|&&a, &&b| {
            let (ra, rb) = (&images[a], &images[b]);
            (ra.width as u64 * ra.height as u64)
                .cmp(&(rb.width as u64 * rb.height as u64))
                .then(ra.bytes.cmp(&rb.bytes))
                .then(rb.path.cmp(&ra.path)) // path は逆順比較で「小さい path = 勝ち」
        })
        .expect("members は 2 以上");

    let reclaimable_bytes: u64 = idx
        .iter()
        .filter(|&&i| i != keeper_i)
        .map(|&i| images[i].bytes)
        .sum();

    // perceptual のみ: グループ内の最大ペア間ハミング距離（緩さの指標）。
    let max_hamming = if strictness == Strictness::Perceptual {
        let hs: Vec<u64> = idx
            .iter()
            .filter_map(|&i| images[i].phash.as_deref().and_then(hash::from_hex))
            .collect();
        Some(max_pairwise_hamming(&hs))
    } else {
        None
    };

    DupGroup {
        id: 0,
        strictness,
        members: idx.iter().map(|&i| images[i].path.clone()).collect(),
        keeper: images[keeper_i].path.clone(),
        reclaimable_bytes,
        // exact/pixel は自動削除可。perceptual は非推移的でチェーン誤連の恐れ → 要目視。
        auto_deletable: strictness != Strictness::Perceptual,
        max_hamming,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(
        path: &str,
        bytes: u64,
        w: u32,
        h: u32,
        sha: &str,
        pix: Option<&str>,
        phash: Option<&str>,
    ) -> ImageRecord {
        ImageRecord {
            path: path.into(),
            bytes,
            width: w,
            height: h,
            format: "png".into(),
            sha256: sha.into(),
            pixel_sha256: pix.map(|s| s.into()),
            phash: phash.map(|s| s.into()),
            thumb: None,
        }
    }

    #[test]
    fn exact_groups_by_sha() {
        let imgs = vec![
            rec("b.png", 10, 8, 8, "AA", None, None),
            rec("a.png", 10, 8, 8, "AA", None, None),
            rec("c.png", 10, 8, 8, "BB", None, None), // 単独
        ];
        let g = group(&imgs, Strictness::Exact, None);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].members, vec!["a.png", "b.png"]); // path 昇順
        assert!(g[0].auto_deletable);
        assert_eq!(g[0].max_hamming, None);
        assert_eq!(g[0].id, 0);
    }

    #[test]
    fn pixel_ignores_none_pixel_sha() {
        // sha は全て別。pixel_sha256 が "PP" の a/b/d だけがグループ化、c(None) は除外。
        let imgs = vec![
            rec("a.png", 10, 8, 8, "S1", Some("PP"), None),
            rec("b.png", 10, 8, 8, "S2", Some("PP"), None),
            rec("c.png", 10, 8, 8, "S3", None, None),
            rec("d.png", 10, 8, 8, "S4", Some("PP"), None),
        ];
        let g = group(&imgs, Strictness::Pixel, None);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].members, vec!["a.png", "b.png", "d.png"]);
        assert!(g[0].auto_deletable);
        assert_eq!(g[0].max_hamming, None);
    }

    #[test]
    fn perceptual_unionfind_chains_non_transitive() {
        // A~B(dist2)・B~C(dist2) だが A~C(dist4)。threshold=2 でも連鎖で 1 グループになる。
        // max_hamming はグループ内最大ペア間 = A-C の 4。
        let imgs = vec![
            rec("a.png", 10, 8, 8, "S1", None, Some("0000000000000000")),
            rec("b.png", 10, 8, 8, "S2", None, Some("0000000000000003")),
            rec("c.png", 10, 8, 8, "S3", None, Some("000000000000000f")),
        ];
        let g = group(&imgs, Strictness::Perceptual, Some(2));
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].members, vec!["a.png", "b.png", "c.png"]);
        assert_eq!(g[0].max_hamming, Some(4));
        assert!(!g[0].auto_deletable); // 要目視
    }

    #[test]
    fn perceptual_separate_when_far() {
        // 距離が threshold を超えるペアは別グループ（= 単独なのでグループ無し）。
        let imgs = vec![
            rec("a.png", 10, 8, 8, "S1", None, Some("0000000000000000")),
            rec("b.png", 10, 8, 8, "S2", None, Some("ffffffffffffffff")), // dist 64
        ];
        let g = group(&imgs, Strictness::Perceptual, Some(10));
        assert!(g.is_empty());
    }

    #[test]
    fn perceptual_none_threshold_defaults_to_10() {
        // 距離 5（≤ 既定 10）。threshold=None でも DEFAULT_PERCEPTUAL_THRESHOLD でグループ化される。
        let imgs = vec![
            rec("a.png", 10, 8, 8, "S1", None, Some("0000000000000000")),
            rec("b.png", 10, 8, 8, "S2", None, Some("000000000000001f")), // popcount=5
        ];
        let g = group(&imgs, Strictness::Perceptual, None);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].max_hamming, Some(5));
    }

    #[test]
    fn keeper_prefers_resolution_then_bytes_then_path() {
        // 解像度優先: b(200x100) が a(100x100,大バイト) に勝つ。
        let imgs = vec![
            rec("a.png", 999, 100, 100, "AA", None, None),
            rec("b.png", 1, 200, 100, "AA", None, None),
        ];
        let g = group(&imgs, Strictness::Exact, None);
        assert_eq!(g[0].keeper, "b.png");
        assert_eq!(g[0].reclaimable_bytes, 999); // keeper 以外 = a

        // 同解像度ならバイト優先: y(800) が x(500) に勝つ。
        let imgs = vec![
            rec("x.png", 500, 50, 50, "AA", None, None),
            rec("y.png", 800, 50, 50, "AA", None, None),
        ];
        let g = group(&imgs, Strictness::Exact, None);
        assert_eq!(g[0].keeper, "y.png");

        // 同解像度・同バイトなら path 昇順（小さい path が keeper）。
        let imgs = vec![
            rec("zzz.png", 100, 50, 50, "AA", None, None),
            rec("aaa.png", 100, 50, 50, "AA", None, None),
        ];
        let g = group(&imgs, Strictness::Exact, None);
        assert_eq!(g[0].keeper, "aaa.png");
    }

    #[test]
    fn no_groups_when_all_unique() {
        let imgs = vec![
            rec("a.png", 10, 8, 8, "S1", None, None),
            rec("b.png", 10, 8, 8, "S2", None, None),
        ];
        assert!(group(&imgs, Strictness::Exact, None).is_empty());
    }

    #[test]
    fn groups_are_ordered_deterministically() {
        // 2 グループ。最小メンバ path 昇順で id を振る。
        let imgs = vec![
            rec("m.png", 10, 8, 8, "G2", None, None),
            rec("z.png", 10, 8, 8, "G2", None, None),
            rec("a.png", 10, 8, 8, "G1", None, None),
            rec("b.png", 10, 8, 8, "G1", None, None),
        ];
        let g = group(&imgs, Strictness::Exact, None);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].members[0], "a.png"); // G1 が先
        assert_eq!(g[0].id, 0);
        assert_eq!(g[1].members[0], "m.png");
        assert_eq!(g[1].id, 1);
    }
}
