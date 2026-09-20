# NEXT — 次セッションへの引き継ぎ

このファイルは**片付いたら削除する一時ファイル**。ロードマップの正本は `TODO.md`、
仕様の正本は `packages/schema/SPEC.md`、web の視覚は `apps/website/UI.md`。
ここに**永久記録を書かない**（決まったことは SPEC / TODO へ移す）。

利用者からの依頼は 2 件あった:

1. ~~**画像フォーマット変換**~~ → **完了**（2026-09-19/20）。SPEC §5.4 + web `/convert`。
   ここに在った調査メモ（引数表・wasm-vips の実測・wasm-vips を自前ビルドしない決定・
   JXL / HEIC の可否）は**すべて SPEC §5.4 へ移した**ので、この節は削除した。
   CLI の `imgdiff convert` は未実装（SPEC に明記済み）。
2. **似た画像が見つかったときに削除できる**ようにする ← **残り**。下の §2 を読むこと。

## 2. 「似た画像の削除」— **現状と食い違う。まずここを読む**

### 2.1 何が食い違うか

利用者の依頼は「**似た**画像が見つかったときに削除」。ところが:

- 今の削除が対象にするのは **`autoDeletable = true`＝ exact（バイト同一）と pixel（画素同一）だけ**。
- **perceptual（＝「似ている」）は SPEC §5 が `autoDeletable = false` と決めていて、
  「自動削除・回収提案はしない」と明記されている。** 理由は**知覚的類似が非推移的**だから
  （A~B かつ B~C でも A~C とは限らない）。union-find の連結成分はチェーンで**無関係な画像を
  同じグループに入れ得る**ので、そのまま消すと**別物を消す**。
- CLI は更に踏み込んで「厳密度に perceptual を選べない」（SPEC §5.1）。

**つまり「似た画像も消せるようにする」は、機能追加ではなく SPEC の決定を変える話。**
黙って `autoDeletable` を無視する実装を書くと、SPEC がその瞬間に嘘になる。

### 2.2 食い違いの解き方 — **案 A に決定（利用者・2026-09-19）**

**決定: 案 A（人が 1 枚ずつ選ぶ）。** perceptual グループは自動では 1 枚も選ばない。
`clean` とは別の名前（例 `delete-selected`）で SPEC に節を足し、選択 UI を web に足す。
`keeper` を消せるようにするか（＝グループ全滅を許すか）は実装時に決める。
以下は決定に至った比較（記録として残す）。

- **案 A: 1 枚ずつ人が選ぶ（推奨）。** perceptual グループは**自動では 1 枚も選ばない**まま、
  サムネにチェックボックスを付けて**人が選んだ物だけ**消す。SPEC §5 の「自動削除しない」は
  保ったまま（自動で提案していない）、消す判断は人が持つ。
  - この場合**これは `clean` ではない**。`clean` は §5.1 で「autoDeletable の keeper 以外」と
    定義済みなので、**別の名前**（例: `delete-selected`）にして SPEC に節を足す。
    同じ名前に 2 つの意味を持たせると、CLI と web で規則が割れる。
  - `keeper` はどうするか要決定。人が選ぶなら keeper も消せて良いはずだが、
    **グループが全滅する**選択を許すかは別問題（「1 枚は残す」を強制するかどうか）。
- **案 B: perceptual も自動削除の対象にする（非推奨）。** 非推移性の問題が残るので、
  やるなら「連結成分ではなく**全対全で距離 ≤ threshold を満たす完全グラフの塊**だけ自動可」
  のような、グループ化側の変更が要る。**SPEC §5 の否決を覆す話**なので、覆すなら
  その根拠（何を前提にした否決だったか）ごと SPEC に書き直す。

### 2.3 実装で再利用できるもの / 足りないもの

**再利用できる（既に在る）:**

- `fsaccess.ts::removeByPath`（親 dir を辿って `removeEntry`）と `requestWritePermission`。
- `scanStore.deleteDuplicates` の**安全の型**: click 内で `readwrite` 昇格（transient activation）→
  per-file 記録（1 件失敗で止めない）→ **世代ガード**（削除中に新スキャンで `result` が
  差し替わっていたら書き戻さない）→ `gcOrphans` で IDB 整合。
- `DeleteDuplicatesButton` の**強確認 AlertDialog**（「元に戻せません・ゴミ箱なし・恒久」を
  アイコン＋テキストで明示＝色に依存しない。件数 / 回収バイト / 対象一覧の dry-run プレビュー）。

**足りない:**

- **選択 UI が 1 つも無い**（チェックボックス / 選択状態のストア / 「全選択」「keeper 以外を選択」）。
- **File[] 経路では削除できない**（永続 handle が無い）。現状もこの経路はボタンを出していない。
  選択 UI を足すときも同じ扱いにすること。

### 2.4 忘れずに

- **web の削除は恒久**（ブラウザにゴミ箱が無い＝`removeEntry` は復元不可）。CLI は `trash` crate で
  ゴミ箱送り。**この非対称は既に `clean.ts` の頭注釈に書いてある** — 選択削除でも同じ強確認を通すこと。
- **FS Access 経路（有効ボタン → AlertDialog → 実削除）は E2E 未検証のまま本番に出ている**
  （TODO.md §3(A)）。選択削除を足す前後で、ここを一度実機で通すのが良い。

---

## 3. 進め方（この repo の作法）

- コードのコメントと文字列は**日本語**（`CLAUDE.md`）。利用者との会話は中国語。
- **何でも手搓しない**（`[[prefer-libraries-not-handrolled]]`）。選択 UI も既存の
  `components/ui` と zustand ストアに寄せる。
- web の視覚は `apps/website/UI.md` が正本。前端を触ると skill `imgdiff-ui` が自動で載る。
- 仕上げは **simplify agent → codex rescue agent**（skill ではなく agent）。
  **破壊的な実削除は特に念入りに**（TODO.md の但し書き）。
- 検証は `vp check` と `vp test`。Rust を触ったら `cargo test`（wasm は
  `wasm-pack test --node crates/wasm`・要 mingw on PATH）。

## 4. 未確認 → **解消（2026-09-19）**

「master と本番が同じ版か」は確認できた。**本番は Polaris の静的サイト**
（`https://img-diff.static.tools.nextop.asia/`）。9/18 に上がっていた配信物の `index.html` が
参照する CSS のハッシュが、master から作り直したビルドのものと**完全一致**した
⇒ 9/18 の配信物は master `4727905` そのもので、本番にだけ在る変更は無かった。

（Cloudflare 側でも同じ確認をしたが、**配信先は Polaris 1 本に決まった**ので
`imgdiff.wgzhao.me` はもう更新していない。詳細は TODO.md §1。）
