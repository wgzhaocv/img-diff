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

- ~~SPEC §1 の固定画像 golden 夹具~~ **2026-09-22 に実装**（`tests/golden.json`・下の節 F）。
- ~~`SCANNABLE_EXTS` と CLI 既定 `--ext` のずれ~~ **2026-09-22 に解消**（下の節 D）。

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

### Codex 性能レビュー（gpt-6-astra/high・2026-09-22）— **未実測の提案。着手前に自分で測る**

**この節の位置づけ**: 読んだのは codex（只読・書き込み無し）で、**走らせた計測は 1 つも無い**。
数字は「バイト量からの導出」か「この仓库に既に在る実測の引用」のどちらかで、各項に区別を書いた。
**Claude 側で核実したのは 4 点だけ** — 上節の実測記録（pool と `createImageBitmap`）/
`lib/compare.ts:91` が主線程で採点している事 / `crates/core/src/compare.rs:32` の `ssim_window()` が
窓ごとに読み直している事 / `workers/hash.worker.ts:51` が `decodeCanonical(bytes, true, …)` で
サムネを無条件に作る事。**それ以外の行番号は未核実**（着手前に自分で開く）。

**前提 — 計時口径は済み（2026-09-22・下の「三画面の性能修正」の節）**: `runIndex` は
`recluster()` を待ってから `elapsedMs` を確定するようになった（本番で `所要 2395 ms` が
クラスタリング込みで出ることを確認済み）。**下の改修の効果はこの数字で測れる。**

**先にやる 4 つ**（収益/コスト順）:

1. ~~**compare を worker へ + 余計なサムネと二重コピーを消す**~~ —— **2026-09-22 に実施**
   （下の「高価値の 6 件」節 A。long task 983/571/566ms → 0）。以下は当時の分析で、
   そのまま実施した内容と一致する。
   - `lib/compare.ts:84` の `compareFiles()` は `yieldToPaint()` で 1 回譲るだけで、
     `compareScores` / `diffHighlight` は**主線程で同期**に走る。
   - `decodeOne()` が使う `workers/hash.worker.ts:46` の `decodeFull()` は
     `decodeCanonical(bytes, true, …)` = **サムネを無条件に作る**のに、`compareFiles()` はそれを
     使っていない ⇒ `wantThumb` を引数にして compare では `false` を渡す。
   - `compare_scores` と `diff_highlight` が**それぞれ** a/b を複製し、後者は出力も複製する。
     12MP 1 組で約 **240MB** の束縛層コピー ⇒ a/b を 1 回で受けて scores と highlight を返す入口を
     `crates/wasm` に足せば約 **144MB**。（**バイト量からの導出。時間は未実測**）
   - 生成物 `src/wasm/imgdiff_wasm.js` を手で直さない（Rust 側の束縛を直して再生成）。
   - 退路: 旧 `compareFiles()` の計算入口を機能切替として残す。transfer 後は元の buffer が
     失効するので worker 側の所有権を明示する。**ビット一致は保たれる**（関数も呼ぶ順も変えない）。

2. **SSIM を厳密な滑動和にする**。`crates/core/src/compare.rs:32` の `ssim()` は完全な 8×8 窓ごとに
   `ssim_window()` を呼び、窓内 64 画素対を**毎回読み直している**（4000×3000 で約 1195 万窓 =
   約 **7.65 億回**の窓内画素対アクセス）。縦 8 行の転がし和 → 横 8 列の滑動で 5 つの整数モーメントを持つ
   （窓内平方和の最大は `64×255² = 4,161,600` で `u32` に収まる）。**f64 へ戻してからの
   平均/分散/共分散/SSIM の式と加算順は変えない** ⇒ **ビット一致は保てる**。
   `W<8 || H<8` の分岐は旧実装のまま。**旧実装を oracle にして逐位比較する**
   （乱数画像 / 定数画像 / 反相関画像 / 細長い画像）。
   **「数倍（3〜10 倍）」は検証目標であって実測ではない。compare 全体が 64 倍になる訳ではない。**

3. **scan の二度手間デコードを消す**。`workers/hash.worker.ts:59` の `hashOne()` は全分解能 RGBA を
   捨てるので、`lib/scan.ts:75` の `secondPassPixels()` が衝突メンバを**もう一度デコード**する。
   1 巡目で pixel SHA 候補（32 バイトだけ保持・全画像は持たない）を作り、バケツ確定後に
   衝突メンバだけ `pixelSha256` へ投影する（CLI の `crates/cli/src/pipeline.rs:28`
   `decode_and_hash()` と同じ作法）。**常に得とは限らない**: 再デコード+白平坦化を D、
   画素ダイジェストを H、候補比率を p とすると、今が `D + p(D+H)`・改修後が `D+H` ⇒
   **`p > H/(D+H)` のときだけ得**。重複の多いアルバムは得、衝突がほぼ無いなら digest 1 回分の損。
   ビット一致は不変（出力の剪定は従来どおり要る）。

4. **IDB を小バッチにする**。`lib/scan.ts:224` の `scanFolder()` は 1 件ごとに `putHash()` +
   `putThumb()` を同期待ちしている。約 50 件 / 100〜250ms でまとめる（サムネは別の best-effort 列）。
   5000 枚で事務数は約 1/50 だが、**総時間の収益は保存が占める割合次第**（5% なら最大でも約 1.05 倍）。
   DESIGN §5 が約 50 件の小バッチを既に許している。

**問うた 3 つ（原生デコード / WebGPU / OPFS）— どれも第 1 巡ではない**:

- **原生デコード（`ImageDecoder` / `createImageBitmap`）**: 上節の「やらないと判断」を**覆さない**。
  判定層に入れられない理由が改めて 4 つ挙がった — JPEG の chroma upsampling の実装差 /
  色管理は実装依存（`colorSpaceConversion:"none"` は vips の再現ではない）/ canvas の premultiply
  丸めが core の整数式と一致しない / `resizeQuality:"high"` は Triangle の重み・標本・丸めを規定しない。
  **dHash は厳密 `<` で比べるので 1 階調の差でビットが反転する。**
  入れてよいのは**表示層**（独立プレビューの初回に vips 初期化を回避）と**予選層**
  （並び替え・優先度付けのみ。正式な候補を落とすのには使えない）。
  なお canonical の順は `decode → autorot → srgb → RGBA → 白平坦化 → Triangle で 9×8 → Rec.601 灰度 → dHash`
  で、**先に灰度化してから縮めるのではない**（順を入れ替えても丸めで結果が動き得る）。
- **WebGPU**: 値打ちが在るのは `CompareView` の `DiffCanvas()` = 差分図を 1 回上げて GPU に置いたまま
  描き続ける形だけ。往復が回収点を決める（12MP = 96MB 上り + 48MB 下り、48MP = 384MB + 192MB）⇒
  **≤1MP は CPU、4〜12MP は実測で交叉点を探す、12MP 超で連続再描画する物だけが候補**
  （試験用の刻みであって確定値ではない）。**SSIM の正式値は GPU に載せられない（WGSL に f64 が無い）** —
  近似プレビューなら可、ただし正式経路と**別物として隔離**する。GPU が出した値は hash キャッシュにも
  clean にも入れない。WebGPU 無し / デバイス喪失 / シェーダ compile 失敗は CPU worker へ直に回退。
- **OPFS**: **搬すべき物が今は無い**。`lib/db.ts:10` が持っているのは小さい `HashEntry` と
  ディレクトリ handle と 256px サムネ Blob だけで、**全分解能 RGBA は元々永続化していない**
  （12MP×5000 枚 = 240GB。持つべきでない）。効くのは搬送ではなく上の #4（バッチ化）。
  OPFS が要るのは「大きい派生物を高頻度で使い回す」場合だけ（diff / 変換結果の LRU）。
  **「数千枚の IDB 対 OPFS の実測差」は出せない** — この仓库にその計測が無く、只読制約では測れない。
  TODO の 60 枚の数字は native CLI のもので、web の IDB の基準にならない。
  併せて**キャッシュ鍵が弱い**: hash の失効条件 `(rootId,path,size,mtime,hashAlgo)` に
  decoder / pipeline の版が無く、thumb は `(rootId,path)` だけで内容版が無い
  （書き込みが失敗すると古い thumb を返し得る）。

**この審査で訂正された事実**（前の要約が嘘だった所）:

- **14.5MB は初回転送量ではない**。vips 本体 + 動的ライブラリ 3 つで約 11.90MB、libheif 1.42MB は
  必要時のみ。ただし `workers/vips.ts:82` の `getVips()` は動的ライブラリ 3 つを**全部**初期化する。
- **HEVC の HEIC は wasm-vips ではなく libheif-js が解く**（`workers/vips.ts:143` の `toSource()` が分流）。
  AV1 の HEIF は vips のまま。
- **JXL は走査に入っていない**（`lib/imagePaths.ts:24`）。変換の対応集合にだけ在る。
- **golden が保証しているのは「同じ RGBA を入れたときの core の native/wasm ビット一致」**で、
  端から端までのデコード一致ではない（SPEC §1 が範囲を限定し、`crates/wasm/src/lib.rs:231` の
  `parity_vectors` は合成 RGBA から始まる）。HEIC は**画素バイトの約 29.9% が異なり最大差 11** で、
  その夹具の dHash がたまたま一致しているだけ。**任意の HEIC へ一般化できない。**

**そのほか（上の 4 つの後）**:

- ~~`screens/ScanScreen.tsx:44` の全店購読~~ / ~~`components/DuplicateGroups.tsx:44` の全メンバ描画~~
  —— **2026-09-22 に実施**（下の節 E）。ただし**完全な仮想スクロールではない**
  （`IntersectionObserver` で読みを遅らせ、グループは 30 件ずつ出す）。
  枚数が万を超えるなら本物の仮想化が要る。
- `lib/scan.ts:179` は DFS 列挙 → 全 `getFile()` → hash の直列。`walkImages()` と `getRootHashes()`
  は重ねられる。
- **プール本数は下げない**（上節の実測）。`vips.concurrency(1)` も維持。vips の常駐には 60 秒の
  遊休回収が既に在る。直せるのは `workers/vips.ts` の「サムネ不要の HEIC 早期 return」に残る
  余計な `getVips()` 呼びの方（**その早期 return は 2026-09-22 から compare で実際に使われている**）。
- **O(N²) は union-find ではなく対探索**（`crates/core/src/cluster.rs:99` の `group_perceptual()` /
  `build_group()` が全対比較）⇒ 同一 dHash を先に畳んで、探索を「異なる hash の個数 U」へ落とす。

### 三画面の性能修正（gpt-6-astra が挙げた未記載 8 件のうち 6 件）— 済・2026-09-22

**上節の未実測リストとは別**。codex（`gpt-6-astra`/high・只読）に三画面を読ませて「TODO に無い物」を
挙げさせた 8 件から、6 件を直した。**実測は実ブラウザ（agent-browser + dev server）で前後を取った。**

**いちばんの収穫は性能ではなくバグ**: `/convert` で **HEIC を開いて何も変えずに保存すると
`heic には書き出せません` で落ちていた**（SPEC §5.4 規則 4 は「元のバイト列をそのまま保存させる」と
明記している）。原因は `prefillDimensions()` が原寸を寸法欄へ入れること —— 旧 `isPassThrough()` は
「寸法欄が空」を要求するので、既定の操作が主線程の短絡を外れ、ワーカーの `saveSpec` で投げていた。
⇒ `isPassThrough` を消して **`passesThrough(options, srcFormat, planned?)` 1 本**にし、
`convertSource`（主線程）/ `cannotWriteReason`（画面）/ `applyConvert`（`workers/vips.ts`）の
**三者が同じ関数を通る**ようにした。`plannedOutput()` は `convertStore` から `convertPlan` へ移した。

**実測（前 → 後）**:

- HEIC を何も触らず保存: **エラー・保存リンク無し → `300×500 · 4.4 KB · heic 変換なし（そのままコピー）`**
  （4480 バイト＝原寸大が落ちる）。
- **4000×3000 の JPEG を何も触らず: 791ms → 804ms。速度の収益は無い。**
  `applyConvert` の `newFromBuffer` は遅延評価で、noop では画素を触らないため。
  **「全部読んで全部デコードしていた」という当初の見立ては実測で否定された。** 省けたのは
  8.6MB の `arrayBuffer()` 1 回とワーカー往復 1 回だけ。
- `/convert` ⇄ `/scan` の往復: **「生成中…」を見た回数 7 → 0**（`renderPreview` に鍵の早切り）。
- `/scan` ⇄ `/convert` の往復: **`recluster` の実行回数 1 → 0**（`clusterIfNeeded` に鍵の記録）。
- 省いた `recluster` 1 回の実費（node・実 wasm）: **N=5000 perceptual 10.5ms / exact 5.7ms。**
  **効果は小さい** —— 12.5M 対の hamming は popcount なので元々速い。

**残る 4 件（性能というより正しさ）**:

- `runBounded()`（`lib/scan.ts`）に**呼び出しごとの停止旗と本物の完了境界**。1 本が落ちた後も
  残りが全件を読み続けていた。`Promise.all` は最初の拒否で返るので、**全員が降りるまで待ってから
  投げる**ようにした（境界が無いと、次のスキャンが始まった後に前のスキャンの runner が
  進捗を書いたり `putHash` を完了したりし得る）。
- `walkImages()` が `{ files, unreadableDirs }` を返し、`scanFolder` は**読めなかったフォルダの下を
  GC しない**（祖先を根まで辿る。文字列の前方一致ではないので `a/b` が `a/bb` を巻き込まない）。
  以前の「空列挙なら GC しない」番人はこれで置き換えた。
- `scanStore`: `recluster` を `clusterIfNeeded()`（store を書かず結果を返す）に割り、
  `result` の差し替えを `replaceResult()` 1 箇所へ。**`groups` は result から導く物なので一緒に捨てる**
  （削除直後にクラスタリングが失敗すると、消えた path が一覧に残り、もう一度削除を押すと
  既に消えた物を消そうとしていた）。`runIndex` は `groups` と `elapsedMs` を**同じ 1 回の更新**で書く
  （`ScanScreen` は store 全体を購読しているので、分けると一覧が丸ごと描き直される）。
  併せて**計時口径を直した**（`recluster` を待ってから `elapsedMs` を確定する）。
- `lib/persistStorage.ts` の `dedupedStorage()` で `persist` の保存先を包んだ。**速度の話ではない**
  （`JSON.stringify` は包みの外で走るので、省けるのは 200 バイトの `setItem` だけ）。
  値打ちは投げても画面を止めないこと。**同期の保存先しか受けないことを型で縛った。**

**本番で確認した（2026-09-22・`https://img-diff.static.tools.nextop.asia/`）**:
`polar static deploy ./dist --name img-diff`（25 ファイル / 14.8MB・URL は不変）。
**新しいブラウザ profile（＝初回訪問・キャッシュ空）で通した**:

- `crossOriginIsolated === true`（COOP/COEP は本番でも効いている。false だと wasm-vips が起動しない）。
- 配信物は master と一致（`index.html` が参照する資産のハッシュが手元の `dist` と同じ）。
- **HEIC を何も触らず保存 → `300×500 · 4.4 KB · heic 変換なし（そのままコピー）` + `download=sample.heic`。**
- `/convert` ⇄ `/scan` の往復で「生成中…」**0 回**（4000×3000 → 1920px の変換を保持したまま）。
- `/scan` 60 枚 → **重複グループ 20 / 重複 40 / 回収可能 29 KB・所要 2395 ms**
  （この「所要」が**クラスタリングを含む**ようになったのが計時口径の修正）。
- `/compare` 2 枚 → 「完全に同一のファイル」+ SSIM 1.0。

**退路について**: `polar static` に版の履歴は無い（`deploy` は中身を差し替え、`archive` は
**今の**中身を落とすだけ）。戻すなら `git checkout 478389c && vp run website#build &&
polar static deploy ./dist --name img-diff`。**今回は上げる前に旧版の zip を取っていない** ——
次からは `polar static archive img-diff --out before.zip` を先に打つ。

**やらないと判断した 2 件**: codex #4「選び直しが排队中の仕事を取り消さない」（convert のプールは
1 本で収益が小さい）/ #7「compare の片側再デコード」（12MP で 48MB の常駐が要る。codex 自身が最低に置いた）。

**レビュー 2 巡で覆った設計判断**（記録として残す）:

- simplify の altitude が「GC は白名単（読めたフォルダだけ消してよい）にせよ、黒名単は fail open」と
  言ったので一度そうしたが、**codex が具体的な漏れを見つけた** —— **フォルダごと消された / 名前を
  変えられた場合、その配下のキャッシュが永久に残る**（消えたフォルダは当然「読めたフォルダ」に
  入らないので守られ続ける）。白名単が防ぐと言っていたのは「投げずに静かに終わる列挙」という
  仮定の話だったので、**具体的な漏れの方を取って黒名単へ戻した**。
- reuse と altitude の両方が「`workers/vips.ts` が述語を再実装している」と指摘。
  あちらは `convertPlan` を既に import しているので、**ワーカーも同じ関数を通す**ようにした
  （それまで「三者が同じ物を見る」と書いたコメントは嘘だった）。

**根本原因として残っているもの（別 commit）**: `prefillDimensions()` が原寸を
**「利用者が指定した寸法」と同じ欄**へ書くこと。ここから既に 3 つの症状が出ている ——
今回の素通しバグ / `renderPreview` が原寸の到着を待たねばならないこと（鍵が変わるので
「選んだ直後だけ倍遅い」・実測 4.2s → 8.5s）/ `infoGen` という世代変数そのもの。
直すなら**原寸は placeholder として見せ、`form.width` は利用者が打つまで空のまま**にする。
`resolveOptions` / `previewKey` / 縦横比の錠 / 寸法欄の描画に触るので、UI の意味が変わる別件。

### 高価値の 6 件（compare をワーカーへ / 寸法欄の根本原因 / Windows 交叉編譯 + 小口 3 件）— 済・2026-09-22

`TODO.md` を価値順に並べ直して選んだ 6 件。**数字は全部この巡で実ブラウザ / wine から取った実測**で、
推測は「推測」と書いてある。

**まず前回の訂正。** 「`prefillDimensions` を直すと実測 4.2s → 8.5s が戻る」と書いたのは**誤り**。
`apps/website/DESIGN.md:199` のその数字は「**原寸を待たずに始めると**倍になる」という意味で、
`renderPreview` の早切りは**その 8.5s を防いでいる側**だった。寸法欄の修正それ自体に
時間の収益は無い —— ただし別の収益が付いてきた（下の B）。

**A — compare の採点と差分をワーカーへ**（`8179248`）

- `compareScores` / `diffHighlight` は主線程で**同期に**走っていた。前後の `yieldToPaint()`
  （`setTimeout(0)`）は進捗の文字を先に描かせるだけで、固まる時間は 1ms も減らない。
- **実測（4000×3000 の png 2 枚・long task）: 983 / 571 / 566ms → 0 / 0 / 0。**
  表示される値は不変（SSIM 0.9634 / PSNR 26.67 / 差分割合 100.00% / ハミング 0 が前後で同一）。
- `crates/wasm` に `compare_all` を足して束縛層の複製を **240MB → 144MB**（**バイト量からの導出**。
  時間は測っていない）。呼ぶ core 関数も引数も同じなのでビット一致で、それを試験で固定した。
- `op:"decode"` は**使いもしないサムネを毎回作っていた**（HEIC では早期 return まで外していた）。
  `wantThumb` を引数にした。**その早期 return が実際に使われるのは今回が初めて**なので、
  vips を往復した画素と一致することを試験で固定した（`applyDecode` を同期 seam として切り出し）。
- 副産物: `/compare` は**主線程の imgdiff-wasm を一度も起こさなくなった**（ハミングもワーカー側）。

**B — 寸法欄の根本原因**（`f2a58bc`）

- `prefillDimensions()` が原寸を「利用者が指定した寸法」と同じ欄へ書いていた。原寸は placeholder で
  見せ、欄は打つまで空にした。空欄こそが原寸なので「原寸」チップは**両方を空にする**。
- **ここで初めて素通しが原寸の到着を待たなくなった**（欄が空なら計画は必ず noop ＝ `planned` 無しでも
  同値に判定できる）。**実測: `sample.heic` 710/684/663ms → 320/313/318ms、
  4000×3000 の JPEG 728/719ms → 315/319ms。** 残り約 315ms はほぼ入力停止の待ち 300ms そのもの。
  9-22 に測った「791ms → 804ms ＝ 収益ゼロ」は、この原寸待ちが残っていたから。
- `convertSource` のプールも遅延にした（素通しならワーカーを 1 本も起こさない）。
- **`infoGen` と `previewKey` の原寸区画は残した。** 前者は二重 `op:"info"` の無駄が残るため、
  後者は消すと `info` 到着で鍵が変わらず**プレビューが永久に出なくなる**ため。

**C — Windows 交叉編譯**（`d9d047e`）

- **arm64 の容器**で交叉編譯する（交叉編譯は宿主の架構を問わないので、amd64 にすると
  Rosetta で遅くなるだけ）。amd64 が要るのは wine で `.exe` を動かす煙試験だけ。
- **libvips は MSYS2 の mingw64 パッケージ**を依存ごと取って展開する。`TODO` が材料として挙げていた
  **公式の `vips-dev-x64-all-8.18.6.zip` は使えなかった** —— あちらの libheif には HEVC の復号器が
  入っておらず（実測: `Support for this compression format has not been built in`）、
  既に検証済みの MSYS2 製パッケージに対して機能が退行する。AV1/AVIF は読めるので気づきにくい。
- **実バグを 1 つ見つけた（wine が無ければ見つからなかった）**: `bundle_root()` が返す
  Windows の `canonicalize` 結果は `\\?\` 付きの verbatim path で、これを `VIPSHOME` として
  libvips（C）へ渡すと解釈されず、**モジュール置き場を見失って HEIC が「未対応の形式」になる**。
  `util::strip_verbatim` で剥がす。**これは wine 特有ではなく実機の Windows でも起きる。**
- 煙試験: 起動 / 名乗りが zip の名前と一致 / **dHash が `tests/golden.json` と一致** /
  HEVC の HEIC が読める。**dHash は原生 mac・wasm・Windows の三者で同じ値**になった。

**D — `tif` / `svg` の扱いを揃えた**（`49a5f99`）

正本を `packages/schema` の `SCANNABLE_EXTS` に置いた。`tif` は CLI 側へ足し（`parse_exts` は
別名を畳まないので両方の綴りが要る）、`svg` は scan の集合から外した —— web は resvg、
CLI は libvips の svgload と**描画器が別**で、dHash が一致する保証が無い。
変換の入力としては web だけが受ける（`CONVERTIBLE_EXTS` に明示で残す）。

**E — 重複一覧は見えている分だけ読む**（`9cb0b5e`）

`Thumb` はマウントと同時に `getThumb()` を打っていた（`loading="lazy"` は IDB 問い合わせを遅らせない）。
**実測（240 枚 / 40 グループ / 重複 200・各 2 回）: `createObjectURL` 240 → 6、`<img>` 240 → 6。**
出る数字は不変。`ScanScreen` の全店購読も欄ごとの selector にした。

**数字を 1 つ取り下げる。** commit の本文には「long task 57ms → 0」と書いたが、**再現しなかった** ——
後から何度測っても 54〜56ms で、前後で変わらない。最初の「0」は一度きりの当たりだったと見る
（この 1 本は主線程の `cluster_group` らしく、**この修正とは無関係にどちらの側にも出る**）。
再現したのは上の 2 つだけなので、記録としてはそちらだけを残す。

**F — jpg/png の golden 夹具**（`eb6ba61`）

SPEC §1 が要求していたのに、あったのは HEIC 1 枚ぶんの shell 台本だけだった。
`tests/fixtures/` + `tests/golden.json` を CLI（`cargo test`）と web（`vp test`）が**同じ json** で読む。
**結果: jpg / png / 透過 PNG / EXIF 回転 jpg の 4 枚は両端が同じ dHash を出した**
（この 4 形式については手順 1〜3 も一致していると初めて機械で言える）。
HEIC はこの集合に入れない（画素が約 29.9% 違う）。
併せて試験の `dynamicLibraries` が resvg を外していた食い違いも塞いだ。

**仕上げレビューで直したもの**（`/simplify` 4 エージェント → codex）

4 つの角度（reuse / simplification / efficiency / altitude）で重なった指摘を当てた。
**自分で書いた誤りが 2 つ見つかった**ので先に挙げる:

- **`strip_verbatim` の注釈と試験が食い違っていた。** 注釈は「UNC は剥がさない」と書いてあるのに、
  試験は**剥がされる**（`UNC\server\…` という道として成り立たない相対パスになる）ことを
  固定していた。網の上に置かれた同梱パッケージで `bundle_root()` が相対パスを返し、
  `update` の入れ替えが別の木を触りに行く。**掛ける場所も 1 段高すぎた** ——
  困るのは `VIPSHOME` から先だけで、Rust の `std::fs` にとって verbatim は得（MAX_PATH が効かない）。
  `util::plain_windows_path` に改め、C へ渡す直前（`set_bundled_vipshome`）でだけ使う。
  UNC は剥がさず **`VIPSHOME` を設定しない**（壊れた道を渡すより、libvips の従来の推定に任せる）。
- **拡張子の「正本」が正本になっていなかった。** Rust の試験は TS の一覧を読まず、**3 つ目の
  手書きリテラル**と突き合わせていた ⇒ TS だけ直しても両方緑のまま。
  `packages/schema/scannable-exts.json` に移し、**Rust は `include_str!` でその json を直接読む**
  （`tests/golden.json` を両側が読むのと同じ作法）。写し間違いが起こらなくなった。

効いた指摘:

- `compare_all` が**差分の判定を二度なめていた**（`pixel_diff_ratio` と `highlight` が同じ
  `pixel_differs` を全画素に当てる）。塗りながら数える `diff::highlight_counted` に変え、
  12MP 1 組で 96MB ぶんの読み直しを消した。値はビット一致（同じ判定・同じ範囲・同じ式）。
- **`useInView` が再描画のたびに監視器を捨てて作り直していた**（`ref` が毎回別の関数だったため）。
  要素を state で持つ形にして `ref` の同一性を固定。併せて `GroupCard` を `memo`。
  **実測: 「もっと見る」1 回で新しく作られる監視器が 60（＝増えた枠のぶんだけ）。**
  直す前は既に出ている 180 も作り直していた。
- **素通しのプレビューが、原寸が届いた瞬間に作り直されていた。** 中身は同じでも `Blob` の
  同一性が変わるので `useObjectUrl` が URL を張り替え、**ブラウザが絵を捨てて再デコードする**
  （4000×3000 で目に見えて瞬く）。設定が同じなら名札だけ付け替えて使い回す。
  **実測: 出力の `Blob` は最後まで同一物**（`createObjectURL` に渡る対象が終始同じ）。
  併せて `PreviewResult.width` の `0` 番兵をやめ（`number | null`）、素通しの寸法は画面が `info` を読む。
- `loadInfo` の世代変数（`infoGen`）を `dedupeInFlight` に置き換え、6 行の言い訳ごと消した。
- 試験の wasm-vips 起動を `tests/options.ts` に寄せた。**`heic` と `convertVips` は resvg を
  外したまま**だったので、svg まわりの差が試験から見えない状態が半分残っていた。
- ワーカーの振り分けを 7 段の入れ子三項から `switch` へ（`default` で取りこぼしに気づける）。
- `compare_scores` / `diff_highlight` を JS から見えなくした（出口は `compare_all` ひとつ）。
- `check_pin` を `scripts/check-release-pins.sh` に括り出し、**Windows 側の発版でも通る**ようにした
  （今までは mac を発版したときしか効かず、Windows だけ発版すると導入導線が古い tag を指したまま）。

**当てなかった指摘と理由**:

- **`scripts/package-windows.sh` を消す / 共有部品に割る**（2 エージェントが提案）。
  重複しているのは事実（DLL 閉包の BFS・配置・zip の作法）。**やらない** ——
  あちらは MSYS2 の実機でしか走らせられず、**此処からは一行も試せない**。
  実機で通した実績のある経路を、wine の煙試験を根拠に消す / 触るのは筋が違う。
  交叉編譯で 1 回発版を通したら、そのとき消すのが順序として正しい。
- **サムネの取得を一覧側へ引き上げる**（`getThumbs(rootId, paths[])` で 1 回の txn にまとめ、
  `Thumb` を表示専用にする）。DESIGN §3 の意図はまさにそれで、指摘は正しい。
  ただし scan の結果の配管（`thumbByPath` の合流）に手を入れる話で、**測らずに触る範囲ではない**。
  下の「まだ塞げていない穴」に残す。

**codex の第二意見（`gpt-5.6-sol` / high / read-only）で直したもの**

「値が変わっていないか」「所有権が壊れていないか」「早切りが甘くないか」は**破綻なし**という判定
（`compare_all` の範囲・判定・式・0 画素の扱いが旧経路と同じこと、transfer 後に detach された
buffer を誰も読んでいないこと、寸法欄が両方空なら `planGeometry` は必ず noop であること、
`sameOptions` が別入力を使い回す経路を持たないこと、を各々根拠付きで確認）。
指摘は 4 件、いずれも**出荷前に当てた**:

- **[高] MSYS2 の版を実は固定していなかった。** `mingw64.db` は生きている索引なので、
  放っておくと「その日の最新」を拾う ⇒ mac と版がずれれば同じ画像から違う画素が出る。
  `PINNED`（libvips 8.18.6-1 / libheif 1.23.5-1）を検査して、違ったら**ビルドを落とす**。
  上流が上がったときに気づかないまま配るのが最悪なので、落ちる方を選んだ。
- **[高] 依存解決の失敗と DLL 不足が非致命だった。** 解決できない依存は `continue` していたし、
  同梱できなかった DLL は並べて見せるだけだった ⇒ **ビルドは通るのに動かない zip** が出来る。
  前者は即失敗に、後者は**Windows が必ず持っている物の allowlist** を作り、外れたら失敗にした。
  **実際にこの護欄が 2 件捕まえた**（`IPHLPAPI.DLL` / `PSAPI.DLL`。どちらも本物の系統 DLL で、
  こちらが列挙し漏らしていた）。併せて展開先が `out` の外へ出ないことも確かめる。
- **[中] UNC で `VIPSHOME` を諦めていたのは誤り。** `\\?\UNC\server\share\…` は
  `\\server\share\…` に**直せる**。設定しないと libvips はビルド時プレフィックスを argv0 より
  先に試すので、網の上に置いたときだけ同梱モジュールを使う保証が無くなる。直す方に改めた。
- **[低] JPEG の夹具が色度を一度も試験していなかった。** `photo.jpg` は 3 面とも同じ模様で
  作ってしまっていて、**全画素で R==G==B**。4:2:0 でも色度が一定なので、README が「chroma
  upsampling の実装差が出る」と書いているのに実際には出しようが無かった。
  3 面それぞれ別の模様で作り直した（全画素が有彩色）。
  **作り直した結果も両端で同じ dHash `1f1f8f0f0703838b`** ＝ 色度補間まで一致していることが
  初めて言えるようになった（mac 原生 / wasm / Windows の三者で確認）。

**本番で通した（2026-09-22・新しい profile ＝ 初回訪問・空キャッシュ）**

`https://img-diff.static.tools.nextop.asia/` —— 上げる前に
`polar static archive img-diff --out before.zip`（14.8MB）で**退路を取ってから**配った
（前回漏らした手順。`polar static` に版の履歴は無いので、これが唯一の戻し先）。

- `crossOriginIsolated === true` / 配信物の資産ハッシュが手元の `dist` と一致
  （`index-CdJw9XcJ.js` / `index-eWrdnS_k.css`）。
- `/convert`: HEIC を開いて何も触らず **316ms で保存できる状態**（寸法欄は空・placeholder に 300）。
  `300×500 · 4.4 KB · heic 変換なし（そのままコピー）`。
- `/compare`: 4000×3000 の png 2 枚で **long task 0ms**。
  SSIM 0.9634 / PSNR 26.67 / 差分割合 100.00% / ハミング 0（手元と同値）。
- `/scan`: 240 枚 → 画像 240 / 重複グループ 40 / 重複 200 / 回収可能 241 KB・**所要 3040 ms**。
  `createObjectURL` **6 回**・`<img>` 6 枚・「もっと見る（残り 10 グループ）」。
- `/convert` ⇄ `/scan` の往復で「生成中…」は **0 回**。

### まだ塞げていない穴

- **リリースがまだ**。Windows 版は交叉編譯で作れるようになった（上の C）が、**上げていない** ——
  v0.1.6 のタグを打ち、mac と win の zip を上げ、`merge-manifest.sh` で `manifest.json` を束ね、
  `install.sh` のタグ直指しを `releases/latest/download` へ戻し、`InstallScreen.tsx` を合わせる。
  そこまでやって初めて `imgdiff update` の自己更新が実際に使える。
- **サムネの取得が `Thumb` 側にある。** DESIGN §3 は「一覧はメタだけ読み、blob は遅延」と
  書いているのに、blob を引く責任が葉に在るままで、`useInView` と分割表示はその上に乗る近似。
  本筋は `getThumbs(rootId, paths[])` で 1 回の txn にまとめて一覧側が配ること
  （FS Access 経路と `File[]` 経路の食い違いも同時に消える）。
- **`scripts/package-windows.sh`（MSYS2 実機用）と `package-windows-cross.sh` が重複している。**
  交叉編譯で 1 回発版を通したら、前者を消すのが順序として正しい。
- **`tests/golden.json` に HEIC は入っていない**（両端で画素が約 29.9% 違うので一致を一般には
  主張できない）。HEIC は今も `scripts/check-heic-parity.sh` がその 1 枚を確かめるだけ。
