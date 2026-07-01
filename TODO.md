# img-diff TODO / ロードマップ

次セッションで続きから作業するためのメモ。詳細仕様は `packages/schema/SPEC.md`、web 設計は `apps/website/DESIGN.md`。

## 完成済み（master に commit 済み）

- **`crates/core`** — dHash / compare(pixelDiffRatio・SSIM・PSNR) / clustering / preprocess(白平坦化・Rec.601グレー)。29 テスト緑。
- **`crates/cli`** — `imgdiff scan`（重複検出・AIフレンドリ出力・redbキャッシュ）/ `imgdiff compare`（2枚の層別スコア + 差分ハイライト `--diff`）。
  libvips は自前 FFI（`crates/cli/src/decode.rs`）。
- **diff 画像ハイライト** — `crates/core/src/diff.rs`（淡化グレー底図 + 差分品紅・pixelDiffRatio と同判定）+ CLI `--diff <path>` で PNG 出力（`image` crate・png feature のみ）。33 テスト緑。
- **性能** — release + キャッシュで実画像60枚 COLD ~2.3s → WARM ~90ms（debug 比 6.7x、再スキャン ~26x）。
- **未着手** — web（`apps/website/`。`UI.md` + skill `imgdiff-ui` は用意済み）。

## 次の手（優先順）

### 1. clean / 削除 ← 安全モデルの合意待ち

- 既定 **dry-run**、`--apply` で実行、**`autoDeletable`（exact/pixel）グループの非 keeper のみ**、**ゴミ箱**へ、perceptual は絶対に自動削除しない（SPEC §5）。

### 2. 小物

- HEIC/AVIF 対応（`pacman -S mingw-w64-x86_64-libheif`、libvips が自動認識）。
- `WalkDir` の走査エラーを `skippedFiles` に記録（codex review #4・低優先）。
- AI 操作手册（tbm の skill 文書に相当・AIフレンドリ仕上げ）。

### 3. web（CLI 完了後）

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
