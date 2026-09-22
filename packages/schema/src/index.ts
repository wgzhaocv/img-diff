// img-diff の web（wasm-vips でデコード + Rust-core-wasm でロジック）と
// CLI（Rust + 原生 libvips）が共有する「契約」。
// ロジックは crates/core の Rust に一本化（CLI=原生 / web=wasm）。
// この TS は web の JS/React 層が使う型。Rust 側 crates/core/src/report.rs と同じ形をミラーし、
// 正本は SPEC.md。

import scannableExts from "../scannable-exts.json" with { type: "json" };

/** JSON の形（フィールド構成）のバージョン。形が壊れる変更で上げる。 */
export const SCHEMA_VERSION = 1 as const;

/** ハッシュ「計算手順」のバージョン。形が同じでも手順が変われば上げる。 */
export const HASH_ALGO_VERSION = "dhash-1";

// ===== ハッシュ仕様（crates/core に一本化。詳細は SPEC.md §1）=====
export const HASH = {
  WIDTH: 8,
  HEIGHT: 8,
  /** グレースケール係数（Rec.601） */
  GRAY: { r: 0.299, g: 0.587, b: 0.114 },
  /** 縮小カーネル（bilinear） */
  RESIZE_KERNEL: "linear",
  /** alpha 平坦化の背景色（白）。両側で統一 */
  FLATTEN_BG: 255,
  /** EXIF 向きを適用してから処理する */
  AUTOROTATE: true,
} as const;

/** ハッシュの総ビット数（= ハミング距離の最大値） */
export const HASH_BITS = HASH.WIDTH * HASH.HEIGHT;

/**
 * **scan が拾う拡張子（小文字・ドット無し）。正本は `scannable-exts.json`。**
 *
 * web の scan と CLI の既定 `--ext` は**同じ集合でなければならない** —— 片方だけが拾う画像が
 * 在ると、同じフォルダに対して両者が違う結果を出す（SPEC §1 の parity が崩れる）。
 * Rust から TS は読めないので、CLI 側は同じ json を `include_str!` で読む。
 * 足し引きするときは json だけを直す。
 */
export const SCANNABLE_EXTS: readonly string[] = scannableExts.exts;

/** 出力の生成元（再現性のため）。producer が違えば phash 比較は慎重に */
export interface Producer {
  app: "web" | "cli";
  /** img-diff 自体のバージョン */
  appVersion: string;
  /** libvips / wasm-vips のバージョン */
  vips: string;
  /** ハッシュ計算手順のバージョン（= HASH_ALGO_VERSION） */
  hashAlgo: string;
}

/**
 * 厳密度の軸（厳 → 緩）。一度の索引で全シグナルを計算し、ここはフィルタに過ぎない。
 * - exact:      ファイルの SHA-256 が一致
 * - pixel:      デコード後ピクセルの SHA-256 が一致（EXIF/再エンコード無視）
 * - perceptual: 知覚ハッシュのハミング距離が threshold 以下
 */
export type Strictness = "exact" | "pixel" | "perceptual";

/** 画像/差分などの参照。CLI はファイルパス、web は data URI で同じ型を使う */
export type AssetRef =
  | { kind: "path"; path: string }
  | { kind: "dataUri"; mime: string; dataUri: string };

/** 1 枚の画像の索引レコード */
export interface ImageRecord {
  /** scan: ルートからの相対パス（'/' 区切り）。compare: 入力で与えたパス/識別子 */
  path: string;
  bytes: number;
  width: number;
  height: number;
  /** libvips/wasm-vips が返す生の形式名（"jpeg" 等） */
  format: string;
  /** ファイル内容の SHA-256（小文字16進64文字） */
  sha256: string;
  /**
   * デコード後ピクセルの SHA-256（pixel 厳密度に使用）。
   * dHash が他と完全一致する候補のみ算出する（SPEC.md §2.1 剪定）。
   * 候補でない / デコード失敗時は null。
   */
  pixelSha256: string | null;
  /** 知覚ハッシュ dHash（16進16文字）。デコード失敗時は null */
  phash: string | null;
  /** UI 用サムネイル（任意） */
  thumb?: AssetRef;
}

/** デコード等で索引から除外したファイル */
export interface SkippedFile {
  path: string;
  reason: string;
}

/** 重複 / 近似のグループ */
export interface DupGroup {
  id: number;
  /** このグループが成立した厳密度 */
  strictness: Strictness;
  members: string[];
  /** 保留推奨（最大解像度 → 最大バイト → path 昇順）。SPEC.md §5 */
  keeper: string;
  /** keeper 以外を削除した場合に回収できるバイト数 */
  reclaimableBytes: number;
  /**
   * 自動削除してよいか。exact/pixel は true。
   * perceptual は類似が非推移的でチェーン誤連の恐れがあるため false（= 要目視）。
   */
  autoDeletable: boolean;
  /** perceptual グループ内の最大ペア間ハミング距離（緩さの指標）。exact/pixel は null */
  maxHamming: number | null;
}

export interface ScanStats {
  scanned: number;
  skipped: number;
  groups: number;
  /** 重複点数（各グループの members 数 - 1 の総和） */
  duplicates: number;
  reclaimableBytes: number;
  elapsedMs: number;
}

/** scan（フォルダ重複検出）の結果 */
export interface ScanReport {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "scan";
  producer: Producer;
  /** スキャンしたルート（表示用） */
  root: string;
  createdAt: string;
  strictness: Strictness;
  /** perceptual のときのみ意味を持つ。他は null */
  threshold: number | null;
  images: ImageRecord[];
  groups: DupGroup[];
  skippedFiles: SkippedFile[];
  stats: ScanStats;
}

/** compare（2 枚を直接比較）の結果。比較不能時は数値は null（SPEC.md §3） */
export interface CompareResult {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "compare";
  producer: Producer;
  createdAt: string;
  a: ImageRecord;
  b: ImageRecord;
  /** SHA-256 一致（= 完全同一ファイル） */
  shaEqual: boolean;
  /** 寸法一致 */
  dimsEqual: boolean;
  /** ピクセル比較が可能か（= dimsEqual）。false の間、下の数値は null */
  comparable: boolean;
  /** デコード後ピクセル一致。比較不能時は null */
  pixelEqual: boolean | null;
  /** 異なるピクセルの割合 0..1。比較不能時は null */
  pixelDiffRatio: number | null;
  /** SSIM 0..1（1 = 同一）。比較不能時は null */
  ssim: number | null;
  /** PSNR(dB)。同一は無限大のため 100 で打ち切り。比較不能時は null */
  psnr: number | null;
  /** 知覚ハッシュのハミング距離（0..HASH_BITS）。phash 欠如時は null */
  hammingDistance: number | null;
  /** 差分ハイライト画像（任意） */
  diffImage?: AssetRef;
}

/** 1 件の削除予定。path / keeper は root 相対（scan と一貫） */
export interface PlannedDeletion {
  path: string;
  /** 属する重複グループ id */
  groupId: number;
  bytes: number;
  /** このグループで残すファイル（root 相対） */
  keeper: string;
}

/** apply 時の 1 件の削除結果 */
export interface Deletion {
  path: string;
  status: "trashed" | "failed";
  /** failed のときのみ理由 */
  error?: string;
}

export interface CleanStats {
  scanned: number;
  /** autoDeletable な重複グループ数 */
  groups: number;
  planned: number;
  trashed: number;
  failed: number;
  elapsedMs: number;
}

/** clean（重複削除）の結果。dry-run/apply 共通の削除計画 + apply 時の実行結果（SPEC.md §5.1） */
export interface CleanReport {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "clean";
  producer: Producer;
  root: string;
  createdAt: string;
  strictness: Strictness;
  /** true=計画のみ（削除せず）。false=--apply で実行済み */
  dryRun: boolean;
  /** 削除予定（autoDeletable グループの keeper 以外）。dry-run/apply 共通 */
  plannedDeletions: PlannedDeletion[];
  /** apply 時の実行結果（1 予定 1 件）。dry-run では空 */
  deletions: Deletion[];
  /** plannedDeletions の bytes 合計 */
  reclaimableBytes: number;
  /** apply で実際にゴミ箱送りできたバイト合計。dry-run は 0 */
  trashedBytes: number;
  stats: CleanStats;
}

/**
 * find の一致の層（strictness と同じ 3 軸）。1 マッチは最上位に該当する 1 層のみ。
 * exact > pixel > perceptual の優先。
 */
export type FindTier = "exact" | "pixel" | "perceptual";

/** find の 1 マッチ。path は探索ルートからの相対（'/' 区切り、scan と一貫） */
export interface FindMatch {
  path: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  tier: FindTier;
  /** 問い合わせ画像との dHash ハミング距離（0..HASH_BITS）。exact/pixel でも実距離を入れる */
  hammingDistance: number;
}

export interface FindStats {
  scanned: number;
  skipped: number;
  /** 一致件数（matches.length） */
  matched: number;
  elapsedMs: number;
}

/**
 * find（1 枚を問い合わせ、フォルダ内で類似検索）の結果（SPEC.md §5.2）。
 * matches は 層順（exact→pixel→perceptual）→ ハミング距離昇順 → path 昇順。
 */
export interface FindReport {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "find";
  producer: Producer;
  /** 探索したルート */
  root: string;
  createdAt: string;
  /** perceptual 層のハミング閾値 */
  threshold: number;
  /** 問い合わせ画像（path は入力で与えたパス。compare の a/b と同じ流儀） */
  query: ImageRecord;
  matches: FindMatch[];
  skippedFiles: SkippedFile[];
  stats: FindStats;
}

/** render の 1 件の結果の状態 */
export type RenderStatus = "rendered" | "skipped" | "failed";

/** render の 1 件（1 入力 → 1 出力）。src/dst は入力の与え方に従う実パス */
export interface RenderItem {
  src: string;
  dst: string;
  /** 出力 PNG の幅・高さ（scale 適用後）。失敗時は 0 */
  width: number;
  height: number;
  /** 出力 PNG のバイト数。rendered 以外は 0 */
  bytes: number;
  status: RenderStatus;
  /** failed のときのみ理由 */
  error?: string;
}

export interface RenderStats {
  scanned: number;
  rendered: number;
  skipped: number;
  failed: number;
  elapsedMs: number;
}

/**
 * render（ベクタ→PNG 栅格化）の結果（SPEC.md §5.3）。
 * imgdiff の本分（重複検出）とは別の補助ツール。非破壊。
 */
export interface RenderReport {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "render";
  producer: Producer;
  /** 入力ルート（ディレクトリ or 単一ファイル） */
  root: string;
  createdAt: string;
  /** 描画スケール（既定 1.0） */
  scale: number;
  /** items は src の昇順（決定性・SPEC §4） */
  items: RenderItem[];
  stats: RenderStats;
}

/** convert の寸法合わせ方（SPEC §5.4）。`w` と `h` が両方在るときだけ効く */
export type ConvertFit = "cover" | "contain" | "fill";

/** convert の切り出し / 余白の寄せ先（SPEC §5.4）。`fit` が効くときだけ意味を持つ */
export type ConvertGravity =
  | "center"
  | "north"
  | "south"
  | "east"
  | "west"
  | "northeast"
  | "northwest"
  | "southeast"
  | "southwest";

/**
 * convert の引数（SPEC §5.4）。**解決後の値**（既定を当てはめ、`quality` は 1..100 に丸めた後）を入れる。
 * `background` は `"transparent"` / `"average"` / 6 桁 hex のいずれか。
 */
export interface ConvertOptions {
  /** 目標幅。未指定なら null */
  width: number | null;
  /** 目標高。未指定なら null */
  height: number | null;
  fit: ConvertFit;
  gravity: ConvertGravity;
  /**
   * `"transparent"` / `"average"` / 6 桁 hex。**`null` は「出力形式ごとの既定」**
   * （png/webp/tiff は透明、それ以外は白）。出力形式が入力と同じ場合、実際の形式は
   * ファイルごとに違うので、既定の解決は**変換する側が 1 件ずつ**行う。
   */
  background: string | null;
  /** 出力形式（別名正規化後）。入力と同じでよいなら null */
  format: string | null;
  /**
   * 1..100。**実際に効くのは jpg / webp / avif / jxl だけ**
   * （png と tiff は渡しても無視され、gif と ppm は渡すと失敗する）。
   */
  quality: number;
  /**
   * 画質を明示したので、寸法も形式も変わらなくても**再符号化する**（素通ししない）。
   * 「同じ形式のまま画質だけ落として圧縮し直す」を成立させるために要る。
   */
  forceReencode: boolean;
}

/** convert の 1 件の結果の状態 */
export type ConvertStatus = "converted" | "skipped" | "failed";

/** convert の 1 件（1 入力 → 1 出力）。src は入力ルート相対、dst は出力先ルート相対 */
/** **CLI 用**（web は 1 枚だけを扱うので作らない・SPEC §5.4 実装状況）。 */
export interface ConvertItem {
  src: string;
  dst: string;
  /**
   * 出力の幅・高さ。**失敗したときと、素通し（デコードせず元のバイト列を渡した）で
   * 寸法が分からないときは 0**（SPEC §5.4 規則 4）。
   */
  width: number;
  height: number;
  /** 出力のバイト数。converted 以外は 0 */
  bytes: number;
  status: ConvertStatus;
  /** failed のときのみ理由 */
  error?: string;
}

/** **CLI 用**（`ConvertItem` と同じ・SPEC §5.4 実装状況）。 */
export interface ConvertStats {
  scanned: number;
  converted: number;
  skipped: number;
  failed: number;
  elapsedMs: number;
}

/**
 * convert（寸法・形式の変換）の結果（SPEC.md §5.4）。
 * imgdiff の本分（重複検出）とは別の補助ツール。非破壊（入力は決して変更しない）。
 */
export interface ConvertReport {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "convert";
  producer: Producer;
  /** 入力ルート（ディレクトリ or 単一ファイル） */
  root: string;
  createdAt: string;
  /** 適用した引数（既定解決後） */
  options: ConvertOptions;
  /** items は src の昇順（決定性・SPEC §4） */
  items: ConvertItem[];
  stats: ConvertStats;
}

/** scan / compare / clean / find / render / convert をまとめた最上位型（--json / レポート） */
export type Report =
  | ScanReport
  | CompareResult
  | CleanReport
  | FindReport
  | RenderReport
  | ConvertReport;
