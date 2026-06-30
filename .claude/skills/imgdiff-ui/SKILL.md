---
name: imgdiff-ui
description: img-diff の web フロント（apps/website）で UI・スタイル・画面・コンポーネントを作る/直すときに使う。配色・タイポ・余白・ダークモード・アクセシビリティ(WCAG AAA)・画像特有UI(サムネ網格/重複グループ/2枚比較)の規範を apps/website/UI.md から読み込み、それに従わせる。React 化・画面追加・CSS/Tailwind 調整・"AIっぽい見た目"の回避でも必ず参照。CLI(crates/cli)には適用しない。
---

# img-diff web UI 規範の適用

`apps/website` のフロントエンドで見た目に触れる作業（画面追加・コンポーネント作成・
CSS / スタイル調整・React 化・ダークモード対応など）をするときに使う。

## 手順

1. **`apps/website/UI.md` を必ず読む**。あれが見た目の正本。本 skill は要点の早見表で、
   数値・トークンの正は UI.md 側にある（重複させず、迷ったら UI.md を引く）。
2. UI.md §5 のデザイントークン（色・タイポ・余白・角丸・影・動き）に沿わせる。
   新しい色や余白を勝手に増やさない。必要なら UI.md に足してから使う。
3. 仕上げに下の「必須チェック」を確認する。

## 必須チェック（外せない原則）

- **主色は Teal**（`--primary #0F766E` / 暗色 `#2DD4BF`）。靛藍ではない。
- **亮色テーマ既定**。暗色は色反転で済ませず、面・罫線・影を個別に設計。
- **統計・件数・容量・SSIM・ハッシュは等幅数字**（`--font-mono` + `tabular-nums`）。
- **WCAG AAA**：本文コントラスト 7:1 以上。teal を文字に使うときは `--primary-text (#115E59)`、
  塗りボタンの白文字以外で薄い teal を小文字に使わない。
- **色を唯一の情報にしない**：選択＝リング+チェック、diff＝色+記号、状態＝色+テキスト。
- **画素 diff は赤/品紅系（`--diff-overlay`）** で teal と補色に。
- **「AIっぽい見た目」禁止**：グラデ文字・発光カード・ネオン暗色・紫ピンクのグラデ・
  装飾emoji・意味のない演出（UI.md §8）。
- **画像が主役、UI は黒子**：余白・抑制・静けさ。`prefers-reduced-motion` を尊重。

## 適用範囲

- 対象：`apps/website/`（web フロント）。
- 対象外：`crates/cli`（CLI に UI はない）、`packages/schema/SPEC.md`（ロジック正本）、
  `apps/website/DESIGN.md`（実装アーキテクチャ）。
