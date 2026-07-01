# img-diff TODO / ロードマップ

次セッションで続きから作業するためのメモ。詳細仕様は `packages/schema/SPEC.md`、web 設計は `apps/website/DESIGN.md`。

## 完成済み（master に commit 済み）

- **`crates/core`** — dHash / compare(pixelDiffRatio・SSIM・PSNR) / clustering / preprocess(白平坦化・Rec.601グレー)。29 テスト緑。
- **`crates/cli`** — `imgdiff scan`（重複検出）/ `imgdiff compare`（層別スコア + 差分ハイライト `--diff`）/ `imgdiff clean`（重複削除・既定dry-run・ゴミ箱）。
  libvips は自前 FFI（`crates/cli/src/decode.rs`）。索引処理は scan/clean で共有（`crates/cli/src/index.rs`）。
- **diff 画像ハイライト** — `crates/core/src/diff.rs`（淡化グレー底図 + 差分品紅・pixelDiffRatio と同判定）+ CLI `--diff <path>` で PNG 出力（`image` crate・png feature のみ）。
- **clean（重複削除）** — `crates/cli/src/clean.rs`。auto_deletable（exact/pixel）の keeper 以外のみを**ゴミ箱**へ（`trash` crate）。既定 dry-run・`--apply` で実行・perceptual は対象外。`CleanReport`（SPEC §5.1）。
- **スキャンエラー記録** — `WalkDir` のエントリエラー（権限拒否等）を握り潰さず `skippedFiles` に記録（scan/clean 共通）。
- **AI 手册 skill** — 正本 `skills/imgdiff-cli/SKILL.md`（**skills.sh 生態**の布局）。CLI は `include_str!` で内嵌し `imgdiff skill` で stdout に表示。常設導入/自動更新/完全性は skills.sh に委譲（`npx skills add github:wgzhaocv/img-diff` / `npx skills update` / lock の `skillFolderHash`）。`~/.agents/skills` へ**自投影しない**（包管理器の領域）。
- **HEIC/HEIF/AVIF 対応** — libheif 導入で libvips が `vips-heif` モジュールを認識。既定 ext に heic/heif/avif 追加（scan/clean）。配布時は libheif + コーデック DLL も同梱要。
- **Windows 自己完結パッケージ** — `scripts/package-windows.sh`（DLL 閉包 + heif モジュールを MSYS2 レイアウト模倣で同梱＝PATH 不要）。zip 54MB。**MSYS2 を PATH から排除した素の環境で scan/compare/HEIC/AVIF 動作を検証済み**。
- **性能** — release + キャッシュで実画像60枚 COLD ~2.3s → WARM ~90ms（debug 比 6.7x、再スキャン ~26x）。
- **未着手** — web（`apps/website/`。`UI.md` + skill `imgdiff-ui` は用意済み）。

## 次の手（優先順）

### 1. 配布の残り（Windows パッケージは完了・tbm 方式を借用）

- 網版チェック（1h クールダウン・通知のみ）+ `imgdiff update`（`self-replace`）+ release manifest+sha256。ホストは **CF 静的**（version.json + アーカイブ + install ページ）。
- **web の install ページで OS を選ばせ対応スクリプトを出す**（CLI は zip、skill は `npx skills add`）。Linux/Mac パッケージは後日（Mac は Mac/CI）。

### 2. web（CLI 完了後）

- `crates/wasm`（wasm-bindgen）+ React UI。設計は `apps/website/DESIGN.md`、見た目は `apps/website/UI.md` + skill `imgdiff-ui`。
- 着手時まず **native==wasm の dHash 一致**を検証（`image` の f32 リサイズが両端でビット一致するか）。

## ビルド/実行メモ（windows-gnu）

```sh
export PKG_CONFIG_PATH="C:\msys64\mingw64\lib\pkgconfig"   # pkg-config が vips を見つける
export PATH="C:\msys64\mingw64\bin:$PATH"                  # 実行時の vips DLL + as/dlltool(binutils)
cargo build --release -p imgdiff                           # 計測は必ず --release（debug は 6.7x 遅い）
```

- 実テスト画像: `C:\Users\wenguangzhao\Downloads\png`。
- libvips の Rust バインディングは windows-gnu で不可 → 自前 FFI。`mingw-w64-x86_64-binutils` が必須。
- 仕上げは simplify agent → codex rescue agent でレビュー（skill でなく agent）。
