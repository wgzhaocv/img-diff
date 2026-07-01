//! AI 手册（skill）。正本は repo の `skills/imgdiff-cli/SKILL.md`（skills.sh 生態で配布する布局）。
//! その内容を `include_str!` で二進制に埋め込み、`imgdiff skill` で stdout に出せる（オフライン便利）。
//!
//! エージェントへの常設導入・自動更新・完全性は **skills.sh**（`npx skills add/check/update`・
//! `~/.agents/skills` + lock の `skillFolderHash`）に委ねる。CLI は自分で `~/.agents/skills` へ
//! 投影しない — そこは skills.sh 包管理器の領域で、手書きは衝突のもと。

use crate::output::OutputFormat;
use anyhow::Result;
use clap::{Args, Subcommand};

/// skill 正本（frontmatter 付き SKILL.md）。skills.sh もこの同一ファイルを配布する。
const SKILL: &str = include_str!("../../../skills/imgdiff-cli/SKILL.md");

/// エージェントへ常設導入するための案内（skills.sh 経由）。
const INSTALL_HINT: &str =
    "エージェントへ常設導入するには（skills.sh）: npx skills add github:wgzhaocv/img-diff";

#[derive(Args)]
pub struct SkillArgs {
    #[command(subcommand)]
    action: Option<SkillAction>,
}

#[derive(Subcommand)]
enum SkillAction {
    /// 内嵌の操作手册を stdout に出す（既定動作）
    Print,
}

/// `imgdiff skill [print]`。内嵌の操作手册を stdout に出す。
/// 常設導入は skills.sh（`npx skills add`）に任せるため、その案内を stderr に添える。
pub fn run(args: SkillArgs, _out: OutputFormat) -> Result<()> {
    let SkillAction::Print = args.action.unwrap_or(SkillAction::Print);
    print!("{SKILL}");
    eprintln!("\n# {INSTALL_HINT}");
    Ok(())
}
