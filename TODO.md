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

### 0. web `/convert` の画面を作り直した（済・2026-09-21）

利用者の指摘 7 点を反映。要点だけ記録する:

- **選んだ画像をサムネで見せる**（それまで件数だけだった）。worker の `op:"hash"` が
  256px webp サムネ + 原寸 + バイト数を一度に返すので、**表示する分だけ**（12 件ずつ）取る。
- **寸法欄の初期値＝代表画像の原寸**。前回設定の記憶（zustand `persist`）とぶつかるので、
  **寸法と上書きだけは記憶しない**（寸法は画像に付随・上書きは安全側へ毎回戻す）。
- **今の指定で効かない欄は描かない**（`lib/convertControls.ts` の純関数 1 箇所で判定）。
  寄せる位置は**余りが出る軸のボタンだけ**を残し（正方形→横長なら上中下だけ）、
  9 マスの形は `invisible` で保つ。
- **代表 1 枚を実際に変換して「変換前/変換後」を出す**（`ConvertPreview`）。
  そのまま 1 枚だけ保存もできる。性能は 3 つの約束で担保:
  入力が止まって 300ms → 同時 1 枚のみ（走行中の要求は最後の 1 回だけ覚える）→ 本番変換中は走らせない。
  **実測**: 4000×3000 の JPEG で総遅延 ~400ms（うち 300ms は待ち＝変換自体は ~100ms）。
  幅を 16ms 間隔で 40 回連打しても、入力が止まってから ~350ms で最終結果（要求は積み上がらない）。
- **画面を部品に割り、進捗の購読を `ConvertProgress` 1 つに閉じ込めた**。
  進捗は実測最大 ~580 回/秒で、殻がそれを読むと画面全体が毎フレーム描き直される。
- **変換結果は保存とコピーができる**。クリップボードは画像として png しか受け取らないので、
  png 以外は見えている結果をそのまま png へ包み直す（実測: 4000×3000 の実写 → 31MB / ~700ms
  なので、待たせる間はボタンを「コピー中…」にする）。

**レビュー 2 巡（simplify 4 エージェント → codex `gpt-5.6-sol`/high）で直した主なもの**:

- サムネが `op:"hash"` を使っていた（1 枚ごとに全分解能 RGBA + dHash + SHA-256）。
  専用の `op:"info"` を足し、`thumbnailBuffer` の shrink-on-load へ。実測 165ms/45.8MB → 53ms/確保なし。
- **効かない欄の判定を代表 1 枚で決めていた**。設定はバッチ全体に掛かるので、
  「正方形の代表には切り取りが無いが横長の 2 枚目には在る」ときに寄せる位置を隠すと、
  見えない設定が 2 枚目のどこを捨てるかを決めてしまう。**全員の原寸が揃っているときだけ**、
  全員の計画の合併で判定するようにした（1 枚でも欠けていれば何も隠さない）。
- `slack` を `planGeometry` の結果に持たせ、画面側での丸めの再計算をやめた。
- 出力先を選んでいる間にフォームが動く（サムネ到着で寸法が入る）と、押したときと違う変換に
  なり得た。`run(sink, options)` にして**押した瞬間の設定で固める**。原寸の自動流し込みも
  選び直しごとに一度だけに。
- プレビューを path だけで突き合わせていたため、設定変更直後や失敗時に**古い絵を「今の結果」として
  保存・コピーできた**。`previewKey` を結果に持たせて突き合わせる。
- 画質欄を隠しても `qualityTouched` が残り、png などで無意味な再符号化を強制していた。
- localStorage の**書き込み**が投げる環境で、変換の開始処理ごと巻き添えになっていた。
- 背景色の検証が、その欄が使われない設定（切り抜き）でも実行を止めていた。

**web の HEIC を読めるようにした（済・2026-09-21）**: wasm-vips 0.0.18 の libheif は
**HEVC を持たない**（AVIF は読める）ので、HEIC だけ `libheif-js`（libde265 入り）で RGBA へ
解いてから wasm-vips に渡す（`workers/heic.ts`）。**HEIC が来るまで取りに行かない**
（転送 gzip 0.48MB。実測で HEIC 無しの選択では取得 0 件）。scan / compare / convert の全部で効く。

- 画素は原生 libvips と一致しない（最大差 11 / SSIM 0.99753）が、**dHash は一致**（hamming 0）。
  根拠と保証の範囲は SPEC §1「デコーダは両端で別物である」、検査は `scripts/check-heic-parity.sh`。
- **読めても書けない**（heic は出力形式に無い）。「変換が要るのに書けない形式」は
  実行前に `validate` が止める（svg も同じ経路で救われる）。

**未解決として残るもの**:

- SPEC §1 が要求する**固定画像の golden 夹具は依然として未実装**。`crates/wasm` の parity は
  合成 RGBA から始まるので**デコーダを 1 つも通らない**。今回 `tests/fixtures/sample.heic` と
  `check-heic-parity.sh` で HEIC だけは塞いだが、jpg/png 等は手動確認のまま。
- `SCANNABLE_EXTS` と CLI 既定 `--ext` が **`tif` と `svg` でずれている**（web だけが拾う）。
  `imagePaths.ts` のコメントは「揃える」と言っているので、どちらかに寄せる必要がある。

### Codex 性能レビュー（gpt-5.6-sol/high）— 対応済みと残り

**実測して否定した提案**（再検討しないための記録）:

- **プール本数を減らす**という提案は**速度には根拠が無い**。24 枚を変換した実測は
  pool=1 713ms / 2 406ms / 4 244ms / **8 164ms**（4.35 倍）。外層の並列は効いている。
  懸念のうち正しいのはメモリの方なので、本数ではなく**画面を離れたら畳む**で対応した。
- **`createImageBitmap` + `OffscreenCanvas`** は今のサムネ経路より遅い。
  640×360 では 5ms 対 9ms で勝つが、**4000×3000 では 22ms 対 10ms で 2.2 倍遅く**、
  サムネも大きい（632B 対 362B）。shrink-on-load が 1/8 解像度で読むぶん、勝負にならない。

**対応済み**: プールを画面離脱で畳む（走行中は畳まない）/ scan の進捗を raf 合流
（`lib/rafThrottle.ts` を convert と共有）+ 進捗の購読を `ScanProgress` に隔離。

**残り**（別途）:

- compare の採点と diff を worker へ（今は主線程で wasm。4000×3000 ×2 で 96MB 入 / 48MB 出のコピー）。
- 重複結果の一覧を仮想化（DESIGN §3 で想定済み・未実装）。
- **やらないと判断**: WebCodecs `ImageDecoder`、応用層の SharedArrayBuffer、
  `WebAssembly.Module` の共有（常駐メモリは減らない）。

### まだ塞げていない穴

- **SPEC §1 が要求する固定画像の golden 夹具**は HEIC のぶんだけ（`tests/fixtures/sample.heic` +
  `scripts/check-heic-parity.sh`）。jpg / png 等は手動確認のまま。
- `SCANNABLE_EXTS` と CLI 既定 `--ext` が **`tif` と `svg` でずれている**（web だけが拾う）。
- Windows のクロスビルド（OrbStack 経路）。材料は確認済み:
  `vips-dev-x64-all-8.18.6.zip`（mac と同じ 8.18.6）+ mingw-w64 + `x86_64-pc-windows-gnu`。
  検証は Wine（Rosetta で amd64 コンテナ）。これが済むと v0.1.6 を latest へ昇格でき、
  `imgdiff update` の自己更新が実際に使えるようになる。
