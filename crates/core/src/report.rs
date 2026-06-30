//! 出力レポートの Rust 表現。`packages/schema/SPEC.md` を正とし、TS の `packages/schema`
//! と同じ形（camelCase で直列化）にする。CLI と wasm が共有する。

use serde::{Deserialize, Serialize};

/// JSON の形のバージョン。
pub const SCHEMA_VERSION: u32 = 1;
/// ハッシュ計算手順のバージョン。
pub const HASH_ALGO_VERSION: &str = "dhash-1";

/// 厳密度の軸。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strictness {
    Exact,
    Pixel,
    Perceptual,
}

/// 出力の生成元（再現性のため）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Producer {
    /// "web" | "cli"
    pub app: String,
    pub app_version: String,
    pub vips: String,
    pub hash_algo: String,
}

/// 画像/差分などの参照（CLI=パス、web=data URI）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AssetRef {
    Path {
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    DataUri {
        mime: String,
        data_uri: String,
    },
}

/// 1 枚の画像の索引レコード。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRecord {
    /// scan: ルートからの相対パス（'/' 区切り）。compare: 入力で与えたパス。
    pub path: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub sha256: String,
    /// デコード後ピクセルの SHA-256。未計算/失敗時は None（= null）。
    pub pixel_sha256: Option<String>,
    /// dHash（16進16文字）。デコード失敗時は None（= null）。
    pub phash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<AssetRef>,
}

/// 索引から除外したファイル。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

/// 重複 / 近似のグループ。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub id: u32,
    pub strictness: Strictness,
    pub members: Vec<String>,
    pub keeper: String,
    pub reclaimable_bytes: u64,
    /// exact/pixel は true。perceptual は非推移的なため false（要目視）。
    pub auto_deletable: bool,
    /// perceptual グループ内の最大ペア間ハミング距離。exact/pixel は None。
    pub max_hamming: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub scanned: u32,
    pub skipped: u32,
    pub groups: u32,
    pub duplicates: u32,
    pub reclaimable_bytes: u64,
    pub elapsed_ms: u64,
}

/// scan（フォルダ重複検出）の結果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub schema_version: u32,
    pub producer: Producer,
    pub root: String,
    pub created_at: String,
    pub strictness: Strictness,
    /// perceptual のときのみ意味を持つ。他は None。
    pub threshold: Option<u32>,
    pub images: Vec<ImageRecord>,
    pub groups: Vec<DupGroup>,
    pub skipped_files: Vec<SkippedFile>,
    pub stats: ScanStats,
}

/// compare（2 枚比較）の結果。比較不能時は数値は None（SPEC.md §3）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub schema_version: u32,
    pub producer: Producer,
    pub created_at: String,
    pub a: ImageRecord,
    pub b: ImageRecord,
    pub sha_equal: bool,
    pub dims_equal: bool,
    /// ピクセル比較が可能か（= dims_equal）。false の間、下の数値は None。
    pub comparable: bool,
    pub pixel_equal: Option<bool>,
    pub pixel_diff_ratio: Option<f64>,
    pub ssim: Option<f64>,
    /// PSNR(dB)。同一は 100 で打ち切り。比較不能時は None。
    pub psnr: Option<f64>,
    /// ハミング距離（0..=64）。phash 欠如時は None。
    pub hamming_distance: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_image: Option<AssetRef>,
}

/// 最上位（kind で判別）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Report {
    Scan(ScanReport),
    Compare(CompareResult),
}
