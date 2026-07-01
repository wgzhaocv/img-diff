//! AI 手册（skill）の内嵌・投影・self-heal。tbm（tsubomi）の方式を借用。
//! skill 正本 `skill/imgdiff-cli.md` を `include_str!` で二進制に埋め込み、その sha256 先頭を
//! 版本戳にする。Claude 全局 skill と Codex 全局 AGENTS.md へ投影し、二進制が新しくなれば
//! 次回実行で戳の不一致を検出して自動で書き直す（**ネット不要** = skill は内嵌内容の投影）。
//! 網越しの版チェック（`imgdiff update` 相当）は配布フェーズで別途足す。

use crate::output::OutputFormat;
use crate::util;
use anyhow::{bail, Context, Result};
use clap::{Args, Subcommand};
use std::fs;
use std::path::PathBuf;

/// skill 正本（frontmatter 無しの可移植 markdown）。どの agent でも読める素の本文。
const BODY: &str = include_str!("../skill/imgdiff-cli.md");

/// Claude skill の frontmatter。`description` が skill 発火の判断材料になる。
const CLAUDE_FRONTMATTER: &str = "---\nname: imgdiff-cli\ndescription: imgdiff CLI（重複/類似画像の検出 scan・2枚比較 compare・重複削除 clean）を AI が駆動するための操作手册。auto JSON 出力・{error,code}・厳密度(exact/pixel/perceptual)・安全な削除フロー（dry-run 既定・ゴミ箱）。imgdiff を使う/呼ぶときに従う。\n---\n";

/// Codex の全局 AGENTS.md に挿す管理ブロックの目印（uninstall がこれを目当てに除去）。
const MARKER_BEGIN: &str = "<!-- >>> imgdiff skill: imgdiff-cli (managed; do not edit) >>> -->";
const MARKER_END: &str = "<!-- <<< imgdiff skill: imgdiff-cli <<< -->";

/// 版本戳 = 本文の sha256 先頭 12 hex。本文が変われば戳も変わり self-heal が投影を書き直す。
fn hash() -> String {
    util::sha256_hex(BODY.as_bytes())[..12].to_string()
}

/// 書き出したファイルに残す戳行。self-heal はこの行の有無で「最新か」を判定する。
fn stamp_line() -> String {
    format!("<!-- imgdiff-skill-hash: {} -->", hash())
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// `~/.claude/skills/imgdiff-cli/SKILL.md`（主ターゲット。self-heal はここの戳を見る）。
fn claude_path() -> Option<PathBuf> {
    Some(home()?.join(".claude/skills/imgdiff-cli/SKILL.md"))
}

/// `~/.codex/AGENTS.md`（Codex の全局指令。管理ブロックを挿す）。
fn codex_path() -> Option<PathBuf> {
    Some(home()?.join(".codex/AGENTS.md"))
}

/// 書き出し先の一覧（`imgdiff skill where` 用）。
fn target_paths() -> Vec<PathBuf> {
    [claude_path(), codex_path()]
        .into_iter()
        .flatten()
        .collect()
}

/// Claude 用の完整内容（frontmatter + 戳 + 本文）。
fn claude_contents() -> String {
    format!("{CLAUDE_FRONTMATTER}{}\n\n{BODY}", stamp_line())
}

/// Codex AGENTS.md に挿す管理ブロック（戳込み）。
fn codex_block() -> String {
    format!("{MARKER_BEGIN}\n{}\n\n{BODY}\n{MARKER_END}\n", stamp_line())
}

/// 全ターゲットへ書き出す（既存は上書き / 置換）。書けたパスを返す。
pub fn install() -> Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    if let Some(p) = claude_path() {
        write_claude(&p)?;
        written.push(p);
    }
    if let Some(p) = codex_path() {
        write_codex_block(&p)?;
        written.push(p);
    }
    if written.is_empty() {
        bail!("ホームディレクトリを解決できませんでした（skill を書き出せません）");
    }
    Ok(written)
}

fn write_claude(path: &PathBuf) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(path, claude_contents())
        .with_context(|| format!("failed to write {}", path.display()))
}

/// AGENTS.md は他の内容と共有しうるので、管理ブロックだけを挿入 / 置換する。
fn write_codex_block(path: &PathBuf) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let existing = fs::read_to_string(path).unwrap_or_default();
    let next = replace_or_append_block(&existing, &codex_block());
    fs::write(path, next).with_context(|| format!("failed to write {}", path.display()))
}

/// 既存テキストの管理ブロックを差し替える。無ければ末尾に足す（前に空行 1 つ）。
fn replace_or_append_block(existing: &str, block: &str) -> String {
    if let (Some(b), Some(e)) = (existing.find(MARKER_BEGIN), existing.find(MARKER_END)) {
        if b < e + MARKER_END.len() {
            let end = e + MARKER_END.len();
            let mut out = String::with_capacity(existing.len());
            out.push_str(&existing[..b]);
            out.push_str(block.trim_end());
            out.push_str(&existing[end..]);
            return out;
        }
    }
    if existing.trim().is_empty() {
        block.to_string()
    } else {
        format!("{}\n\n{block}", existing.trim_end())
    }
}

/// self-heal のクールダウン（秒）。AI は連続実行するので、毎回チェック（ファイル読み）しない。
const SELF_HEAL_COOLDOWN_SECS: u64 = 3600;

/// 最終 self-heal チェック時刻の刻印先（scan の redb キャッシュと同じ OS キャッシュ領域）。
fn state_path() -> Option<PathBuf> {
    let dir = dirs::cache_dir().unwrap_or_else(|| PathBuf::from(".imgdiff"));
    Some(dir.join("imgdiff").join("skill-check"))
}

fn now_epoch() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 直近 `SELF_HEAL_COOLDOWN_SECS` 内にチェック済みか。
fn cooldown_active() -> bool {
    let Some(p) = state_path() else {
        return false;
    };
    match fs::read_to_string(&p)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
    {
        Some(last) => now_epoch().saturating_sub(last) < SELF_HEAL_COOLDOWN_SECS,
        None => false,
    }
}

/// 現在時刻を刻印する。書けたら `true`。
fn stamp_cooldown() -> bool {
    let Some(p) = state_path() else {
        return false;
    };
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&p, now_epoch().to_string()).is_ok()
}

/// self-heal: 毎起動で呼ぶが **1 時間クールダウン**する。クールダウンが明けていれば、主ターゲットが
/// 無い（未導入）か戳が古ければ全ターゲットへ書き出す（＝毎回自動投影・更新）。書いたら `true`。
/// tbm の version_check と同型で、チェック前に刻印する（刻印できないならチェックしない — さもないと
/// クールダウンが無効化され毎コマンドが I/O を払う）。失敗は黙って `false`。
pub fn ensure_fresh() -> bool {
    if cooldown_active() {
        return false;
    }
    if !stamp_cooldown() {
        return false;
    }
    let Some(primary) = claude_path() else {
        return false;
    };
    let fresh = fs::read_to_string(&primary)
        .ok()
        .is_some_and(|c| c.contains(&stamp_line()));
    if fresh {
        return false;
    }
    install().is_ok()
}

/// 両ターゲットを残留物ゼロで消す。Claude = skill ディレクトリごと、
/// Codex = 管理ブロックのみ除去（他の内容は残す。空になればファイルも消す）。best-effort。
fn remove() {
    if let Some(p) = claude_path() {
        if let Some(dir) = p.parent() {
            let _ = fs::remove_dir_all(dir);
        }
    }
    if let Some(p) = codex_path() {
        if let Ok(existing) = fs::read_to_string(&p) {
            if existing.contains(MARKER_BEGIN) {
                let stripped = strip_block(&existing);
                if stripped.trim().is_empty() {
                    let _ = fs::remove_file(&p);
                } else {
                    let _ = fs::write(&p, stripped);
                }
            }
        }
    }
}

/// 管理ブロックを取り除く（前後の余分な空白は整える）。マーカーが無ければそのまま。
fn strip_block(existing: &str) -> String {
    let (Some(b), Some(e)) = (existing.find(MARKER_BEGIN), existing.find(MARKER_END)) else {
        return existing.to_string();
    };
    let end = e + MARKER_END.len();
    if b >= end {
        return existing.to_string();
    }
    let before = existing[..b].trim_end();
    let after = existing[end..].trim_start_matches('\n');
    if before.is_empty() {
        return after.to_string();
    }
    if after.is_empty() {
        return format!("{before}\n");
    }
    format!("{before}\n\n{after}")
}

#[derive(Args)]
pub struct SkillArgs {
    #[command(subcommand)]
    action: Option<SkillAction>,
}

#[derive(Subcommand)]
enum SkillAction {
    /// skill を Claude / Codex に書き出す（既存は上書き）
    Install,
    /// 書き出した skill を削除する
    Uninstall,
    /// skill 本文を stdout に出す
    Print,
    /// 書き出し先のパス一覧を出す
    Where,
}

/// `imgdiff skill <action>`。手册の投影を明示操作する（通常は起動時の self-heal が自動でやる）。
pub fn run(args: SkillArgs, _out: OutputFormat) -> Result<()> {
    match args.action.unwrap_or(SkillAction::Print) {
        SkillAction::Print => print!("{BODY}"),
        SkillAction::Install => {
            for p in install()? {
                println!("書き出し: {}", p.display());
            }
        }
        SkillAction::Uninstall => {
            remove();
            println!("skill を削除しました（best-effort）");
        }
        SkillAction::Where => {
            for p in target_paths() {
                println!("{}", p.display());
            }
        }
    }
    Ok(())
}
