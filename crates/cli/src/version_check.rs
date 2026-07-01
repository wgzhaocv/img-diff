//! CLI 実行後のバージョン通知（tbm version_check.rs 同型）。GitHub Releases の latest を見て、
//! 現行版と違えば stderr に一行通知する。**1h クールダウン**（成功/失敗問わずチェック前に刻印）、
//! 短いタイムアウト、失敗は全て沈黙（fail-open）。呼び出しは **text モードのコマンド成功後のみ**
//! （JSON 出力を汚さない）。ネット/JSON はこのモジュールだけ。

use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;

/// リリースを配布する GitHub リポジトリ。version = tag。
const REPO: &str = "wgzhaocv/img-diff";
const COOLDOWN_SECS: u64 = 3600;
const TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Deserialize)]
struct Release {
    tag_name: String,
}

/// クールダウンが明けていて、GitHub Releases の最新版が現行版と違えば stderr に通知する。
/// 失敗（ネット不通・レート制限・未リリース等）はすべて沈黙。
pub fn maybe_notify() {
    if cooldown_active() {
        return;
    }
    // チェック前に刻印（刻印できなければチェックしない — さもないと毎回ネットを叩く）。
    if !stamp_now() {
        return;
    }
    let Some(latest) = fetch_latest() else {
        return;
    };
    let current = env!("CARGO_PKG_VERSION");
    if latest != current {
        eprintln!(
            "\n新しい版 {latest} があります（現在 {current}）。`imgdiff update` で更新できます。"
        );
    }
}

/// GitHub Releases の latest から version（tag、先頭 v を除去）を取る。
fn fetch_latest() -> Option<String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .build(),
        )
        .timeout_global(Some(TIMEOUT))
        .build()
        .into();
    let body = agent
        .get(&url)
        .header("User-Agent", "imgdiff-cli")
        .header("Accept", "application/vnd.github+json")
        .call()
        .ok()?
        .body_mut()
        .read_to_string()
        .ok()?;
    let rel: Release = serde_json::from_str(&body).ok()?;
    Some(rel.tag_name.trim_start_matches('v').to_string())
}

/// 最終チェック時刻の刻印先（scan の redb キャッシュと同じ OS キャッシュ領域）。
fn state_path() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("imgdiff").join("version-check"))
}

fn now_epoch() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cooldown_active() -> bool {
    let Some(p) = state_path() else {
        return false;
    };
    match std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
    {
        Some(last) => now_epoch().saturating_sub(last) < COOLDOWN_SECS,
        None => false,
    }
}

fn stamp_now() -> bool {
    let Some(p) = state_path() else {
        return false;
    };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, now_epoch().to_string()).is_ok()
}
