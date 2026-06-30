//! AI フレンドリ出力層（tbm と同型）。**stdout=データ・stderr=進捗/警告**。
//! 成功は DTO を裸の `serde_json` で stdout（信封なし・フィールド安定・jq 可）、
//! エラーは main が `{error,code}` を stdout に出して非零終了する。

use anyhow::Result;
use serde::Serialize;

/// 出力形式。text=人間向け整形、json=機械(AI/スクリプト)向け構造化。
/// auto(既定)= stdout が端末なら text、パイプ/捕捉なら json。
/// imgdiff も AI 駆動が主用途なので、捕捉時に既定で構造化されるのが要点
/// （AI 側が `-o` を覚えなくてよい）。全コマンド共通のグローバル `-o/--output`。
#[derive(Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum OutputFormat {
    Auto,
    Text,
    Json,
}

impl OutputFormat {
    /// auto を実フォーマットへ解決する。stdout が端末(人が見る)なら text、
    /// パイプ/リダイレクト(AI・スクリプトが拾う)なら json。
    pub fn resolve(self) -> OutputFormat {
        match self {
            OutputFormat::Auto => {
                use std::io::IsTerminal;
                if std::io::stdout().is_terminal() {
                    OutputFormat::Text
                } else {
                    OutputFormat::Json
                }
            }
            resolved => resolved,
        }
    }

    pub fn is_json(self) -> bool {
        matches!(self.resolve(), OutputFormat::Json)
    }
}

/// Serialize 値を 1 つ stdout へ(pretty・裸 DTO)。各コマンドが json 分岐で使う。
pub fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
