---
name: imgdiff-cli
description: imgdiff CLI（重複/類似画像の検出 scan・2枚比較 compare・重複削除 clean）を AI が駆動するための操作手册。auto JSON 出力・{error,code}・厳密度(exact/pixel/perceptual)・安全な削除フロー（dry-run 既定・ゴミ箱）。imgdiff を使う/呼ぶときに従う。
allowed-tools: Bash(imgdiff:*)
---

# imgdiff CLI 操作手册（AI 向け）

重複・類似画像を扱う CLI `imgdiff`。**AI 駆動が主用途**（tbm と同型: auto JSON 出力・`{error,code}`・非対話・stdout=データ/stderr=進捗）。
サブコマンドは 3 つ: **scan**（フォルダ内の重複/類似をグループ化）・**compare**（2 枚を直接比較）・**clean**（重複を安全に削除）。

## 出力の約束（重要）

- **`-o, --output` は `auto`（既定）/ `text` / `json`**。auto は「端末なら text・パイプ/捕捉なら json」。環境変数 `IMGDIFF_OUTPUT` でも指定可。
  → **AI は出力を捕捉するので既定で JSON になる**。`-o` を明示しなくてよい。確実にしたいなら `-o json`。
- **成功**: 裸の JSON DTO を stdout（pretty・信封なし・フィールド安定）。**進捗/警告は stderr**。
- **失敗**: stdout に `{"error": "...", "code": "..."}` を出して**非零終了**。`code` は機械分岐用:
  `not_found`（読み込み失敗）/ `decode_error`（デコード失敗・libvips 未検出等）/ `io_error`（書き込み失敗）/ `unsupported`（未対応）/ `error`（その他）。
- 最上位 JSON は `kind` で判別: `"scan"` / `"compare"` / `"clean"`。全出力に `producer {app, appVersion, vips, hashAlgo}`。

## 厳密度（strictness）

| 値           | 判定                                                                | 用途                                   |
| ------------ | ------------------------------------------------------------------- | -------------------------------------- |
| `exact`      | ファイル SHA-256 一致（バイト完全同一）                             | 最保守                                 |
| `pixel`      | デコード後ピクセル一致（EXIF/再エンコード無視。同じ絵の別ファイル） | 「同じ画像」の自然な重複               |
| `perceptual` | 知覚ハッシュ（dHash）のハミング距離 ≤ `--threshold`（既定 10）      | 見た目が近い（要目視・自動削除しない） |

`exact`/`pixel` グループは `autoDeletable=true`、`perceptual` は**非推移的で誤連鎖の恐れがあり `autoDeletable=false`（要目視）**。

## scan — フォルダの重複/類似検出

```
imgdiff scan <FOLDER> [--strict exact|pixel|perceptual] [--threshold N] [--ext jpg,png,...] [--full] [--json <FILE>] [--no-cache]
```

- 既定 `--strict perceptual`・`--threshold 10`・再帰あり・`--ext jpg,jpeg,png,webp,gif,bmp,tiff,heic,heif,avif`。redb キャッシュで再スキャン高速化（`--no-cache` で無効）。
- **stdout 既定は要約**（`groups[]` + `skippedFiles[]` + `stats` + `producer`、`images[]` は省く＝トークン節約）。完全版は `--full`（stdout）か `--json <file>`（ファイル）。
- 主フィールド: `groups[].{id, strictness, members[], keeper, reclaimableBytes, autoDeletable, maxHamming}`、`stats.{scanned, skipped, groups, duplicates, reclaimableBytes, elapsedMs}`。
  `keeper` = 残す推奨（最大解像度 → 最大バイト → path 昇順）。`members`/`keeper`/`skippedFiles[].path` は**ルート相対（'/' 区切り）**。

## compare — 2 枚を直接比較

```
imgdiff compare <A> <B> [--tolerance N] [--diff <OUT.png>]
```

- 主フィールド: `shaEqual, dimsEqual, comparable, pixelEqual, pixelDiffRatio(0..1), ssim(0..1), psnr(dB・同一は100), hammingDistance(0..64)`。
  **寸法不一致（`comparable=false`）だと pixelEqual/pixelDiffRatio/ssim/psnr は `null`**（「比較不能」と「不一致」を区別）。
- `--tolerance N`（既定 0）: 各チャンネル差がこれ以下は同一扱い。
- `--diff <path>`: **寸法一致時のみ**、差分ハイライト PNG を書き出す（A のグレー淡化ベース + 差分画素を品紅）。JSON の `diffImage` にパスが入る。

## clean — 重複を安全に削除（破壊的・既定は安全側）

```
imgdiff clean <FOLDER> [--strict exact|pixel] [--apply] [--ext ...]
```

- **既定は dry-run**（何も削除せず `plannedDeletions[]` を出すだけ）。**`--apply` で初めて実削除**。
- 削除先は**ゴミ箱のみ**（復元可能）。永久削除の口は無い。**削除対象は `autoDeletable`（exact/pixel）グループの keeper 以外だけ**。keeper は必ず残る。
- **`--strict` は exact / pixel のみ**（既定 pixel）。**perceptual は選べない**（自動削除しない）。
- 削除時点で**その場で再スキャン**（毎回新規デコード＝キャッシュを信じない）。
- 主フィールド: `dryRun, plannedDeletions[].{path, groupId, bytes, keeper}, deletions[].{path, status:"trashed"|"failed", error?}, reclaimableBytes, trashedBytes, stats`。1 件失敗しても止めず per-file 記録。

## 典型ワークフロー

1. **重複を消す**: `imgdiff scan <dir> --strict pixel` で groups 確認 → `imgdiff clean <dir> --strict pixel`（dry-run で予定確認）→ 問題なければ `--apply`。
2. **2 枚がどう違うか**: `imgdiff compare a.png b.png --diff diff.png` → スコア + どこが違うかの PNG。
3. 大量の完全レポートが要るとき: `imgdiff scan <dir> --json report.json`。

## 注意

- 終了コード 0=成功、非零=失敗（JSON 時は `{error,code}` が stdout）。分岐は `code` で行う。
- HEIC/HEIF/AVIF は libvips に libheif がある構成で対応（既定 ext に含む）。libheif 無しの配布物では `decode_error`。JXL 等はまだ未対応。
- 実行時に libvips ランタイムが要る。`decode_error`（libvips 初期化失敗）なら、同梱 DLL/ライブラリの配置か PATH を確認。
