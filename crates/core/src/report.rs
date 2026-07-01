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

/// clean（重複削除）の結果。dry-run/apply 共通の削除計画 + apply 時の実行結果。SPEC.md §5.1。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanReport {
    pub schema_version: u32,
    pub producer: Producer,
    pub root: String,
    pub created_at: String,
    pub strictness: Strictness,
    /// true=計画のみ（削除せず）。false=--apply で実行済み。
    pub dry_run: bool,
    /// 削除予定（auto_deletable グループの keeper 以外）。dry-run/apply 共通。
    pub planned_deletions: Vec<PlannedDeletion>,
    /// apply 時の実行結果（1 予定 1 件）。dry-run では空。
    pub deletions: Vec<Deletion>,
    /// planned_deletions の bytes 合計。
    pub reclaimable_bytes: u64,
    /// apply で実際にゴミ箱送りできたバイト合計。dry-run は 0。
    pub trashed_bytes: u64,
    pub stats: CleanStats,
}

/// 1 件の削除予定。path / keeper は root 相対（scan と一貫）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedDeletion {
    pub path: String,
    /// 属する重複グループ id。
    pub group_id: u32,
    pub bytes: u64,
    /// このグループで残すファイル（root 相対）。
    pub keeper: String,
}

/// apply 時の 1 件の削除結果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deletion {
    pub path: String,
    pub status: DeletionStatus,
    /// failed のときのみ理由。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 削除結果の状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeletionStatus {
    Trashed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanStats {
    pub scanned: u32,
    /// auto_deletable な重複グループ数。
    pub groups: u32,
    pub planned: u32,
    pub trashed: u32,
    pub failed: u32,
    pub elapsed_ms: u64,
}

/// find（1 枚を問い合わせ、フォルダ内の類似を層別に列挙）の一致の層。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FindTier {
    /// ファイル SHA-256 一致（バイト完全同一）。
    Exact,
    /// デコード後ピクセル一致（EXIF/再エンコード無視）。
    Pixel,
    /// dHash のハミング距離が閾値以下（知覚的に近い・要目視）。
    Perceptual,
}

/// find の 1 マッチ。path は探索ルートからの相対（'/' 区切り、scan と一貫）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindMatch {
    pub path: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub tier: FindTier,
    /// 問い合わせ画像との dHash ハミング距離（0..=64）。exact/pixel でも実距離を入れる。
    pub hamming_distance: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindStats {
    pub scanned: u32,
    pub skipped: u32,
    pub matched: u32,
    pub elapsed_ms: u64,
}

/// find（1 枚を問い合わせ、フォルダ内で類似検索）の結果。SPEC.md §5.2。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindReport {
    pub schema_version: u32,
    pub producer: Producer,
    /// 探索ルート。
    pub root: String,
    pub created_at: String,
    /// perceptual 層のハミング閾値。
    pub threshold: u32,
    /// 問い合わせ画像（path は入力で与えたパス。compare の a/b と同じ流儀）。
    pub query: ImageRecord,
    /// 層順（exact→pixel→perceptual）・距離昇順・path 昇順で並ぶ（SPEC §4 決定性）。
    pub matches: Vec<FindMatch>,
    pub skipped_files: Vec<SkippedFile>,
    pub stats: FindStats,
}

/// render（SVG→PNG 栅格化）の 1 件の結果の状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderStatus {
    /// PNG を書き出した。
    Rendered,
    /// 出力先が既に存在し --overwrite 無しのため飛ばした。
    Skipped,
    /// デコード/書き込みに失敗（error に理由）。
    Failed,
}

/// render の 1 件（1 入力 → 1 出力）。path は入力ルートからの相対（'/' 区切り）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderItem {
    /// 入力（SVG 等）のパス。
    pub src: String,
    /// 出力 PNG のパス。
    pub dst: String,
    /// 出力 PNG の幅・高さ（scale 適用後）。失敗時は 0。
    pub width: u32,
    pub height: u32,
    /// 出力 PNG のバイト数。rendered 以外は 0。
    pub bytes: u64,
    pub status: RenderStatus,
    /// failed のときのみ理由。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStats {
    pub scanned: u32,
    pub rendered: u32,
    pub skipped: u32,
    pub failed: u32,
    pub elapsed_ms: u64,
}

/// render（ベクタ→PNG 栅格化）の結果。SPEC.md §5.3。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderReport {
    pub schema_version: u32,
    pub producer: Producer,
    /// 入力ルート（ディレクトリ or 単一ファイル）。
    pub root: String,
    pub created_at: String,
    /// 描画スケール（既定 1.0）。
    pub scale: f64,
    /// items は src の path 昇順（決定性・SPEC §4）。
    pub items: Vec<RenderItem>,
    pub stats: RenderStats,
}

/// 最上位（kind で判別）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Report {
    Scan(ScanReport),
    Compare(CompareResult),
    Clean(CleanReport),
    Find(FindReport),
    Render(RenderReport),
}
