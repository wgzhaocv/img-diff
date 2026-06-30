//! CLI のエラー型。`code` は AI が機械分岐できる安定コード（json エラー信封 `{error,code}` で使う）。
//! anyhow に載せて伝播し、main で downcast して code を取り出す（tbm の ApiError と同型）。

use std::fmt;

/// 安定エラーコード付き CLI エラー。message は人間向けで、可能なら**次アクション**を含める
/// （例: 「フォルダが見つかりません（パスを確認）」）。
#[derive(Debug)]
pub struct CliError {
    /// 機械分岐用の安定コード。例: not_found / decode_error / unsupported / io_error / usage。
    pub code: &'static str,
    pub message: String,
}

impl CliError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CliError {}
