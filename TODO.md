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
- **自己更新チェーン** — version-check（GitHub Releases・1h・text で通知・ureq native-tls）+ `imgdiff update`（DL + sha256 検証 + **rename-aside で exe/DLL 束を差し替え** + 起動時 .imgdiff-old 掃除）。**v0.1.2 で実リリース検証済み**（0.1.1→0.1.2 自己更新成功）。ホストは GitHub Releases（`wgzhaocv/img-diff`）。
- **性能** — release + キャッシュで実画像60枚 COLD ~2.3s → WARM ~90ms（debug 比 6.7x、再スキャン ~26x）。
- **web wasm 化 + parity 検証（Phase 0 完了・commit 済）** — `crates/wasm` を wasm-bindgen で公開
  （flatten_and_dhash / dhash_hex / hamming_hex / compare_scores / diff_highlight / cluster_group）。
  **golden fixture で native == wasm32 のビット一致を検証済**（`image` の f32 リサイズも f64 累積も両端同値
  → 共有 core 前提が成立）。compare の pixel_equal は JS が pixelSha256 一致で導出（CLI と同義）。
  リリース wasm 159KB（wasm-opt 後）。ツールチェーン: `rustup target add wasm32-unknown-unknown` +
  `wasm-pack`（~/.cargo/bin）。テスト: `wasm-pack test --node crates/wasm`（要 mingw on PATH）。
- **未着手** — web の React UI 本体（`apps/website/`。`UI.md` + skill `imgdiff-ui` は用意済み）。

## 次の手（優先順）

### 1. 配布の残り（Windows パッケージ + 自己更新チェーンは完了）

- **web の install ページで OS を選ばせ対応スクリプトを出す**（CLI は GitHub Releases の zip、skill は `npx skills add github:wgzhaocv/img-diff`）。web 本体と一緒に。
- Linux/Mac パッケージ + それらの release（Mac は Mac/CI）。自己更新チェーンは同機構でそのまま載る（target を manifest に足すだけ）。

### 2. web（`crates/wasm` + parity は完了。次は React UI）

- **Phase 0 完了**: `crates/wasm`（wasm-bindgen）+ native==wasm parity 検証（上記「完成済み」参照）。
- **Phase 1 完了（commit 済 7fc1b54）**: React 化 + UI 骨格。4 エージェントレビュー反映済み。
  **shadcn/ui + Tailwind v4** を土台に、`src/index.css` で
  UI.md トークンを shadcn の意味変数へ写像（Teal・WCAG AAA・反AI・亮/暗）。scan / compare / install の
  シェル + ハッシュルータ + テーマトグル。`vp dev`（localhost:5173）で実機確認済（亮/暗・3画面・コンソール綺麗）。
  型/lint/整形（`vp check`）緑。UI スタックの約束は記憶 [[web-ui-stack-shadcn-tailwind]] 参照。
  ※ scan/compare の実処理は未結線（Phase 2/3）。ボタンは現状プレースホルダ（toast）。
- **Phase 2 完了（commit 済 0705469）**: ワーカープール + wasm-vips デコード。Web Worker（wasm-vips
  でデコード → imgdiff-wasm で dHash、sha256 は crypto.subtle）を固定プールで並列処理。**実機で web の
  dHash が CLI と一致確認済み**（`workers/vips.ts::decodeCanonical` は CLI decode.rs と同順）。error 耐性
  （onerror で reject+補充）・中断ガード・shadcn Progress・4 エージェントレビュー反映済み。scan 実処理は動作、
  ただしグループ化・キャッシュ・削除は未（Phase 3）。**要計測（Phase 3）**: pthread 過剰購読・N×vips メモリ・
  shrink-on-load（DESIGN §7.1）。
- **Phase 3 完了（commit 済・要 hash）**: scan オーケストレーション + グループ表示。runScan（1 パス目
  sha256+dHash → dHash 衝突バケットのみ 2 パス目 pixelSha256、SPEC §2.1）→ cluster_group（メイン/wasm）で
  厳密度別（exact/pixel/perceptual + 閾値・切替は再スキャン不要・閾値は debounce）→ DuplicateGroups（keeper
  「残す」・回収容量・チェッカー背景サムネ）。skipped 表示・同名 drop の取りこぼし回避・format 正規化。
  **共有契約 `schema` の型（Strictness/ImageRecord/DupGroup）を website から再利用**（手書き重複を解消）。
  **実機検証済み**（重複ペアがグループ化・3 モード切替・web dHash==CLI）。4 エージェントレビュー反映済み。
- **Phase 3b 基盤 完了（commit 済 d8201b2）**: File System Access + IndexedDB hashes キャッシュ。
  `lib/db.ts`（idb・roots/jobs/hashes/thumbs スキーマ・逐次 putHash・storage.persist）、`lib/fsaccess.ts`
  （showDirectoryPicker・isSameEntry で rootId 安定化・再帰列挙）、`lib/scan.ts::scanFolder`（列挙−突合→ミス分
  だけ hash→pixelSha256、キャッシュ再利用）。runScan と 2 パス目を共通 seam `secondPassPixels` に統一。
  3 エージェントレビュー反映（F1 StrictMode の abortedRef 致命バグ・F2 per-file skip・F3 SPEC§2.1 presence
  再導出・F5 leak 防止・F6 失敗非キャッシュ・列挙並列化 ほか）。tsc/lint/build 緑、File[] 回帰は preview 検証済み。
  ※ **FS Access のフォルダ選択はネイティブダイアログのため agent-browser 自動検証不可 → 要 `vp dev` 手動確認**。
- **Phase 3b サムネ 完了（commit 済・要 hash）**: worker がデコード時に ~256px webp サムネ生成（premultiply
  で透過エッジ対策）→ File[] は thumbByPath / FS Access は IDB thumbs（putThumb は best-effort）。Thumb は
  thumb Blob→IDB→原 File の優先度。実機（File[]）でサムネ表示検証済み。2 エージェントレビュー反映（thumb 失敗を
  非致命に・putThumb を quota 耐性に・thumb を transfer）。**要計測（DESIGN §6 は許容）**: 全画像 eager encode /
  File[] の thumbByPath O(N) メモリ（表示は重複メンバのみ）。cache-hit 画像のサムネ backfill は未（file 表示で代替）。
- **Phase 3b 残り**: 中断再開 UI（jobs ストア・「前回の続行」）+ 実削除（readwrite 権限・確認・removeEntry。
  web はゴミ箱不可＝恒久削除の確認 UI）+ 保存 handle 再利用（queryPermission/requestPermission で再選択なし再開）
  - グループ仮想化 + shrink-on-load（§7.1）+ pixelSha256 の native==wasm byte golden + キャッシュ GC/reconcile。
- Phase 4: compare モード UI + install ページ → CF Workers Static Assets へデプロイ検証。
- 設計は `apps/website/DESIGN.md`、ロジック正本は `packages/schema/SPEC.md`。

## ビルド/実行メモ（windows-gnu）

```sh
export PKG_CONFIG_PATH="C:\msys64\mingw64\lib\pkgconfig"   # pkg-config が vips を見つける
export PATH="C:\msys64\mingw64\bin:$PATH"                  # 実行時の vips DLL + as/dlltool(binutils)
cargo build --release -p imgdiff                           # 計測は必ず --release（debug は 6.7x 遅い）
```

- 実テスト画像: `C:\Users\wenguangzhao\Downloads\png`。
- libvips の Rust バインディングは windows-gnu で不可 → 自前 FFI。`mingw-w64-x86_64-binutils` が必須。
- 仕上げは simplify agent → codex rescue agent でレビュー（skill でなく agent）。
