//! imgdiff — 重複・類似画像を検索する CLI。
//! AI 駆動が主用途（tbm と同型の AI フレンドリ出力: auto JSON・{error,code}・stdout/stderr 分離）。

use anyhow::Result;
use clap::{Parser, Subcommand};

mod cache;
mod compare;
mod decode;
mod error;
mod output;
mod pipeline;
mod scan;
mod util;

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
    /// フォルダを走査して重複/類似画像をグループ化する
    Scan(scan::ScanArgs),
    /// 2 枚の画像を直接比較する（並べて + ピクセル diff + SSIM）
    Compare(compare::CompareArgs),
}

fn main() {
    let cli = Cli::parse();
    let out = cli.output.resolve();
    let json = out.is_json();

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
}

fn run(command: Cmd, out: OutputFormat) -> Result<()> {
    decode::init()?; // libvips 初期化（失敗時はここでエラー）
    match command {
        Cmd::Scan(args) => scan::run(args, out),
        Cmd::Compare(args) => compare::run(args, out),
    }
}
