// 画像パスまわりの共有部品（scan / convert が使う）。
// 「どれを画像とみなすか」「拡張子の切り出し」「path の一意化」「決定的な並び」を 1 箇所に置く。

/**
 * **scan が拾う拡張子。CLI の既定 `--ext` と揃える。**
 * scan は web と CLI で同じ結果を出す契約（SPEC §1 の dHash parity）があるので、
 * ここを CLI より広げると「web だけが拾う画像」が生まれて結果が食い違う。
 */
const SCANNABLE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
  "svg",
]);

/**
 * **convert が読み込む拡張子。** scan と違って CLI との結果一致の契約が無い（変換は web のみ・
 * SPEC §5.4）ので、wasm-vips が読める物はすべて受ける。`jxl` はここにだけ在る
 * ——CLI の Windows 版が libjxl 非同梱なため、scan 側に足すと parity が崩れる。
 */
const CONVERTIBLE_EXTS = new Set(
  [...SCANNABLE_EXTS, "jxl"].filter(
    // bmp は wasm-vips に loader が無い（実測: "not in a known format"）。
    // scan 側は CLI の既定 ext に合わせて残すが、convert で受けると必ず per-file 失敗になる。
    (e) => e !== "bmp",
  ),
);

/**
 * 拡張子（小文字・ドット無し）。ディレクトリ名にドットが在っても誤らないよう、
 * 最後の `/` より後ろの `.` だけを見る（`a.dir/photo` は拡張子無し）。
 */
export function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot + 1).toLowerCase() : "";
}

/** scan の対象か（CLI の既定 ext と同じ集合）。 */
export function isScannableImage(name: string): boolean {
  return SCANNABLE_EXTS.has(extOf(name));
}

/** convert の入力として読めるか（scan の集合 + jxl）。 */
export function isConvertibleImage(name: string): boolean {
  return CONVERTIBLE_EXTS.has(extOf(name));
}

/**
 * path キーを一意にする。フォルダ選択は webkitRelativePath / 相対パスなので元から一意だが、
 * **ドロップされた loose File は別フォルダの同名ファイルが衝突し得る**。
 * 衝突したら連番を付けて**取りこぼさない**（同じキーで上書きして静かに 1 件消えるのを防ぐ）。
 */
export function uniquePath(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = 2;
  let key = `${stem} (${n})${ext}`;
  while (used.has(key)) key = `${stem} (${++n})${ext}`;
  return key;
}

/**
 * コードポイント比較。**`localeCompare` は使わない** —— 環境で順序が変わり、
 * Rust CLI と出力順が食い違う（SPEC §4 の決定性）。
 */
export const compareCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
