//! imgdiff — 重複・類似画像を検索する CLI。
//! AI 駆動が主用途（tbm と同型の AI フレンドリ出力: auto JSON・{error,code}・stdout/stderr 分離）。

use anyhow::Result;
use clap::{Parser, Subcommand};

mod cache;
mod clean;
mod compare;
mod decode;
mod error;
mod find;
mod index;
mod output;
mod pipeline;
mod render;
mod scan;
mod skill;
mod update;
mod util;
mod version_check;

use output::OutputFormat;

#[derive(Parser)]
#[command(name = "imgdiff", version, about = "重複・類似画像を検索する")]
struct Cli {
    /// 出力形式（env: IMGDIFF_OUTPUT）。auto=端末は text・パイプ/捕捉は json（AI 向け）
    #[arg(
        long,
        short = 'o',
        global = true,
        default_value = "auto",
        env = "IMGDIFF_OUTPUT"
    )]
    output: OutputFormat,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// フォルダをスキャンして重複/類似画像をグループ化する
    Scan(scan::ScanArgs),
    /// 2 枚の画像を直接比較する（並べて + ピクセル diff + SSIM）
    Compare(compare::CompareArgs),
    /// 1 枚の画像に似たものをフォルダ内で探し、層別（exact/pixel/perceptual）に列挙する
    Find(find::FindArgs),
    /// SVG(ベクタ)を PNG に栅格化する（フォルダ一括・--scale で高精細・--out-dir で別保存）
    Render(render::RenderArgs),
    /// 重複画像を安全に削除する（既定 dry-run・--apply でゴミ箱へ）
    Clean(clean::CleanArgs),
    /// AI 手册（skill）を stdout に出す（常設導入は skills.sh: npx skills add）
    Skill(skill::SkillArgs),
    /// 最新版へ自己更新する（GitHub Releases から取得・sha256 検証・同梱 DLL ごと差し替え）
    Update,
}

fn main() {
    let cli = Cli::parse();
    // 前回 update で残った *.imgdiff-old を掃除（同梱パッケージのみ・best-effort・開発ビルドは無処理）。
    update::cleanup_old();
    let out = cli.output.resolve();
    let json = out.is_json();
    // scan/compare/clean を text で実行し成功したときだけ、更新通知を出す（1h クールダウン・fail-open）。
    let notify_update = !json
        && matches!(
            cli.command,
            Cmd::Scan(_) | Cmd::Compare(_) | Cmd::Find(_) | Cmd::Render(_) | Cmd::Clean(_)
        );

    let result = run(cli.command, out);

    // json モードのエラーは {error,code} を stdout に出して非零終了（機械分岐用）。
    // text モードは "Error: …" を stderr に出して非零終了。
    if let Err(e) = result {
        if json {
            let code = e
                .downcast_ref::<error::CliError>()
                .map(|c| c.code)
                .unwrap_or("error");
            let envelope = serde_json::json!({ "error": format!("{e:#}"), "code": code });
            println!("{envelope}");
        } else {
            eprintln!("Error: {e:#}");
        }
        std::process::exit(1);
    }

    if notify_update {
        version_check::maybe_notify();
    }
}

fn run(command: Cmd, out: OutputFormat) -> Result<()> {
    // 画像系は libvips を初期化してから（失敗時はここでエラー）。skill は libvips 不要なので初期化しない。
    match command {
        Cmd::Scan(args) => {
            decode::init()?;
            scan::run(args, out)
        }
        Cmd::Compare(args) => {
            decode::init()?;
            compare::run(args, out)
        }
        Cmd::Find(args) => {
            decode::init()?;
            find::run(args, out)
        }
        Cmd::Render(args) => {
            decode::init()?;
            render::run(args, out)
        }
        Cmd::Clean(args) => {
            decode::init()?;
            clean::run(args, out)
        }
        Cmd::Skill(args) => skill::run(args, out),
        Cmd::Update => update::run(),
    }
}
