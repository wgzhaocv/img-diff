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

### 2. web（Phase 0〜3b サムネまで完了・commit 済。scan は実用レベルで動作）

**▶ 再開時の次アクション（新しい chat はまずここを読む）**

- **現状（すべて本番デプロイ済・最新 version `c736b4e7`・imgdiff.wgzhao.me 稼働）**:
  - **scan**（フォルダ重複検索）+ **compare**（2枚比較）が動作。全経路で **web dHash==CLI**。
  - compare = 並べて / 境界スライダ / 差分ハイライト(canvas) + SSIM/PSNR/差分割合/ハミング等幅表示 + 段階進捗（読込→計算→差分）。
  - **ライブラリ化済**（ユーザー指摘「何でも手搓するな」[[prefer-libraries-not-handrolled]]）:
    ルーティング=**react-router v8**（`BrowserRouter`+`Routes`+`NavLink`・**URL は `#` なしのクリーンパス** `/compare` 等）、
    状態=**zustand**（`src/lib/stores/scanStore.ts`・`compareStore.ts`＝ルート切替でも結果/選択/進捗/**ワーカープール**保持・
    props ドリリング解消。`DuplicateGroups` は結果をストア直読み）、before/after=**react-compare-slider**、
    perceptual しきい値=**shadcn Slider**（`components/ui/slider.tsx`・0〜32・debounce は画面側）。
  - catalog（root package.json）の **vite-plus/vite を `0.2.2` に固定**（`latest` が root/workspace で割れ、vite の
    Plugin 型が二重定義になり型崩れ→版固定で単一化。今後 `vp add` 後に型崩れしたらまずここを疑う）。
  - UI 文言は日本語（「査重」等の中国語は排除。scan タブ=「重複を探す」）。install ページは**未実装**（Phase 1 のプレースホルダ）。
- **今やること = Phase 3b 残り。(A) 実削除は完了・commit 済（下の「### 3」参照）。★本番未デプロイ＝ユーザーが `vp dev` で
  使い捨てフォルダ検証後に `wrangler deploy`★**。次は (B) 保存 handle 復用 + 中断再開、または (C) 低リスクの小物。
  agent-browser で File[] 経路（削除ボタン無効化）は確認済み。FS Access 経路の実削除だけはネイティブ選択のため `vp dev` 手動確認。
- **検証環境（重要・更新）**: このセッションには **`agent-browser` skill が利用可能**（実ブラウザ駆動＝
  compare や FS Access もスクショ/操作で確認できる可能性あり。まず試す）。**`codex:setup`/`codex:rescue` skill も存在**
  （setup で CLI 準備を確認してから rescue を回す。以前「codex 未インストール」と記録したが skill 経路が来た）。
  ただし FS Access の**フォルダ選択ダイアログ自体**はネイティブなので、確実なのは依然 `vp dev` 手動確認。
- **仕上げレビュー**: 各まとまりで simplify=4 エージェント並列（reuse/simplification/efficiency/altitude）
  [[simplify-means-4-agent-review]]。※直近は Anthropic 側 session limit で一部しか回らず inline 代替した回あり。
  破壊的な実削除は特に念入りに（codex rescue も可能なら併用）。
- **手順**: 実装 → レビュー反映 → `vp check`（型/lint/整形）→ `vp build` → 検証 → master 直接コミット
  [[commit-directly-no-branch]] → （非破壊なら）`cd apps/website && wrangler deploy`（個人 CF・wgzhaocv@gmail.com・
  imgdiff.wgzhao.me）。ビルドに mingw PATH 不要（wasm pkg は `apps/website/src/wasm` にコミット済）。
- **このセッションの commit（新しい順）**: `580edec`(Slider) `e981c1a`(選択ボタン hover 修正＝secondary→primary +
  wasm init を `{module_or_path}` に＝deprecated 警告解消) `2cffc16`(todo) `0723630`(査重→日本語) `b5454f5`(react-router+
  zustand+react-compare-slider 採用・手書きルータ削除) `76b7120`(進捗表示/スライダ/`#`廃止/タブ状態保持の初版※後で b5454f5 が上書き)
  `f6195ae`(todo) `8ca0b62`(compare Phase 4a)。作業ツリーはクリーン想定。

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
- **Phase 3 完了（commit 済 b481b79）**: scan オーケストレーション + グループ表示。runScan（1 パス目
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
- **Phase 3b サムネ 完了（commit 済 ca2e88e）**: worker がデコード時に ~256px webp サムネ生成（premultiply
  で透過エッジ対策）→ File[] は thumbByPath / FS Access は IDB thumbs（putThumb は best-effort）。Thumb は
  thumb Blob→IDB→原 File の優先度。実機（File[]）でサムネ表示検証済み。2 エージェントレビュー反映（thumb 失敗を
  非致命に・putThumb を quota 耐性に・thumb を transfer）。**要計測（DESIGN §6 は許容）**: 全画像 eager encode /
  File[] の thumbByPath O(N) メモリ（表示は重複メンバのみ）。cache-hit 画像のサムネ backfill は未（file 表示で代替）。
- **Phase 4a 完了（commit 済 8ca0b62）**: compare（2 枚比較）。worker に op="decode" 追加（白平坦化後の
  全分解能 RGBA を transfer で返す。hashOne/decodeOne は共通 `decodeFull` を op ごとに射影＝重複解消）→
  主線程 core の `compareScores`/`diffHighlight`/`hammingHex`（CompareScores は getter 読取後に free）で
  ペア演算。`lib/compare.ts`（sha/dims/hamming + dimsEqual 時に SSIM/PSNR/差分割合/差分RGBA。pixelEqual は
  差分割合0で導出＝tolerance0 でバイト一致と同値）→ `CompareView`（総合判定 + 等幅メトリクス + 並べて/
  境界スライダ/差分canvas）・`ImageSlot`（ドロップ/選択+プレビュー）・`useObjectUrl`。数値の正しさは
  native==wasm の golden parity（crates/wasm）が既に保証。**`schema` の exports import を src へ**（値 import
  `HASH_BITS` を解決。型は元々 src 参照）。simplify レビュー反映（decodeFull 一本化・pixelEqual 導出・
  comparable 別名廃止・decodeOne 戻り型で二重ガード解消ほか）。型/lint/整形・build 緑。
  ※ **worker/DOM 結線は agent-browser 不可のため `vp dev` で手動確認要**（メトリクス値・3 表示切替・差分描画）。
- **Phase 4a 後の UX 改修 完了（commit 済）**: 段階進捗（compare）・スライダ handle 化→react-compare-slider・
  `#` 廃止(react-router)・タブ切替の状態保持(zustand)・「査重」→日本語・選択ボタン hover 修正(secondary→primary)・
  wasm init を `{module_or_path}` 化（deprecated 警告解消）・perceptual しきい値を shadcn Slider に。全て本番反映済。
- **Phase 4b（残り）**: install ページ（OS 選択で出し分け）+ 再デプロイ。install.ps1 は既に本番稼働
  （`https://imgdiff.wgzhao.me/install.ps1`）。Mac/Linux バイナリは未リリース→「build from source / 近日」表示は要ユーザー判断。
- 設計は `apps/website/DESIGN.md`、ロジック正本は `packages/schema/SPEC.md`。

### 3. Phase 3b 残り（← (A) 実削除 完了・commit 済。次は (B) or (C)）

**(A) 実削除 完了（commit 済・★本番未デプロイ＝ユーザー検証待ち★）**

CLI `crates/cli/src/clean.rs`（SPEC §5.1）の安全モデルを踏襲。**破壊的・恒久（web にゴミ箱なし＝removeEntry は復元不可）**。
対象は `autoDeletable=true`（exact/pixel）グループの keeper 以外のみ。perceptual は絶対に削除しない・keeper は必ず残す。

- **実装**（すべて `apps/website/src/`）:
  - `lib/clean.ts`（新規）: `planDeletions(groups, images)`（純関数・CLI `clean.rs::plan_deletions` と規則一致＝autoDeletable のみ・
    keeper 除外・`PlannedDeletion` は共有契約 `schema` を再利用）+ `applyDeletions(root, rootId, planned)`（1 件ずつ
    **恒久削除** removeEntry → 成功時のみキャッシュ掃除 → per-file 記録・1 件失敗で止めない）。
  - `lib/fsaccess.ts`: `removeByPath(root, path)`（`/` 分解 → 末尾以外 `getDirectoryHandle` → 親で `removeEntry`。`''`/`'.'`/`'..'`
    セグメントは throw＝防御的。FS Access は構造的に root 配下しか辿れずサンドボックスが封じ込めを強制）+ `requestWritePermission`
    （**削除の click 内**で `requestPermission({mode:"readwrite"})`＝transient activation 保持。scan は read のみ・段階要求 DESIGN §6.3）。
  - `lib/db.ts`: `deleteHash`（正本＝throw 可）/ `deleteThumb`（best-effort＝内部 swallow。put\* と対の設計）。
  - `lib/stores/scanStore.ts`: `rootHandle` 保持（File[] 経路は null）+ `deleteDuplicates`（権限 → applyDeletions →
    **削除中に新スキャンで result が差し替わっていたら書き戻さない世代ガード**（`get().result === result`・clusterToken と同型）→
    store/IDB reconcile → 再クラスタ → toast）。二重起動は `deleting` ガード。
  - `components/ui/alert-dialog.tsx`（新規・shadcn/radix unified import）+ `components/DeleteDuplicatesButton.tsx`（新規）:
    「N 件を削除（M 回収）」ボタン → **強確認 AlertDialog**（「元に戻せません・ゴミ箱なし・恒久」をアイコン+テキストで明示＝
    色依存でない・件数/回収バイト/対象一覧最大100件の dry-run プレビュー）。**File[] 経路は永続 handle が無く削除不可 →
    ボタン無効化 + 理由表示**。busy 中はクローズ抑止・`e.preventDefault()` で非同期完了までダイアログを保持。
- **検証済**: `vp check`（型/lint/整形）+ `vp build` 緑。**agent-browser で File[] 経路を実機確認**（重複7枚→autoDeletable 2 群・
  削除ボタン「3 件を削除」が disabled + 理由文言・keeper リング表示）。※ **FS Access 経路（有効ボタン→AlertDialog→実削除）は
  ネイティブのフォルダ選択が要るため agent-browser 不可 → ユーザーが `vp dev` で使い捨てフォルダ検証後にデプロイ**。
- **レビュー**: simplify=4 エージェント並列（reuse/simplification/efficiency/altitude）実施・反映済み（PlannedDeletion を schema 再利用・
  死条件削除・reconcile 世代ガード）。安全不変条件（keeper/perceptual 保護・transient activation・per-file 安全・reconcile 順序）は
  altitude レビューで確認済み・ブロッカーなし。codex は導入済みだが未ログイン（回すなら `!codex login`）。
- **繰延べた最適化（実利小・破壊的パスは簡潔=安全優先。将来必要なら）**: ① `removeByPath` の親ディレクトリ再解決（ネスト深い
  フォルダで大量削除時 O(D×深さ)。親ごとに handle を 1 回解決してグルーピング）② IDB 掃除を削除ループ後に 1〜2 txn でバッチ化。
  ③ `planDeletions` を crates/core へ寄せ wasm 共有（clusterGroup と同型・CLI/TS の規則 drift 防止）。

**(B) 保存 handle 復用 + 中断再開（(A) と権限フロー共通）**

- 起動時に `getRoots()`（`roots` に dirHandle 永続済み・`resolveRoot` が putRoot 済み）から前回フォルダを提示 →
  `queryPermission`→（click 内）`requestPermission`→ `scanFolder(handle)` はキャッシュ突合で高速再スキャン。
- `jobs` ストア（db.ts に定義済・未使用）で `status!="done"` の未完了ジョブを検出 →「前回の続行」提示。
  逐次 putHash 済みなので残りだけ hash。DESIGN §5「再開フロー」。

**(C) 低リスクの小物（agent-browser/自前で検証しやすい）**

- **キャッシュ GC/reconcile**: scan 時に列挙に無い（削除/移動された）path の hashes/thumbs を掃除。削除後にも呼ぶ。
- **pixelSha256 byte golden**: `crates/wasm` に native==wasm の pixelSha256（`rgba_sha256`）一致テスト（要 mingw on PATH）。
- **グループ仮想化**: 数千グループ時。`@tanstack/react-virtual`（ライブラリ・可変高）。実利が出てから。
- **shrink-on-load（DESIGN §7.1）**: 1 パス目を縮小デコードで高速化。導入時 **dHash parity(golden) を必ず再実行**。「先に計測」方針。

## ビルド/実行メモ（windows-gnu）

```sh
export PKG_CONFIG_PATH="C:\msys64\mingw64\lib\pkgconfig"   # pkg-config が vips を見つける
export PATH="C:\msys64\mingw64\bin:$PATH"                  # 実行時の vips DLL + as/dlltool(binutils)
cargo build --release -p imgdiff                           # 計測は必ず --release（debug は 6.7x 遅い）
```

- 実テスト画像: `C:\Users\wenguangzhao\Downloads\png`。
- libvips の Rust バインディングは windows-gnu で不可 → 自前 FFI。`mingw-w64-x86_64-binutils` が必須。
- 仕上げは simplify agent → codex rescue agent でレビュー（skill でなく agent）。
