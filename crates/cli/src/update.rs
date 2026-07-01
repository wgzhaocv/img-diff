//! `imgdiff update`: GitHub Releases の latest から Windows パッケージ(zip)を取得し、sha256 検証して
//! 現在のインストール(exe + DLL 束)を **rename-aside** で in-place 差し替えする。
//! 実行中の exe/DLL は Windows でロックされ上書きは不可だが、rename（旧 → `.imgdiff-old`）は可能なので
//! 差し替えられる。反映は次回起動から。残った `.imgdiff-old` は起動時 [`cleanup_old`] が掃除する。
//! ネット/zip はこのモジュールと version_check だけ。

use crate::util;
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const REPO: &str = "wgzhaocv/img-diff";
const TARGET: &str = "x86_64-pc-windows-gnu";
const OLD_SUFFIX: &str = ".imgdiff-old";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}
#[derive(Deserialize)]
struct Manifest {
    targets: Vec<TargetEntry>,
}
#[derive(Deserialize)]
struct TargetEntry {
    target: String,
    asset: String,
    sha256: String,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(180)))
        .build()
        .into()
}

fn get_text(agent: &ureq::Agent, url: &str) -> Result<String> {
    Ok(agent
        .get(url)
        .header("User-Agent", "imgdiff-cli")
        .header("Accept", "application/vnd.github+json")
        .call()?
        .body_mut()
        .read_to_string()?)
}

fn get_bytes(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>> {
    Ok(agent
        .get(url)
        .header("User-Agent", "imgdiff-cli")
        .call()?
        .body_mut()
        .with_config()
        .limit(512 * 1024 * 1024) // アーカイブは数十〜数百 MB になり得る
        .read_to_vec()?)
}

pub fn run() -> Result<()> {
    let agent = agent();
    let current = env!("CARGO_PKG_VERSION");

    let rel: Release = serde_json::from_str(&get_text(
        &agent,
        &format!("https://api.github.com/repos/{REPO}/releases/latest"),
    )?)
    .context("最新リリース情報の取得/解析に失敗しました（未リリースかネット不通）")?;
    let latest = rel.tag_name.trim_start_matches('v').to_string();
    if latest == current {
        println!("すでに最新です（{current}）。");
        return Ok(());
    }
    println!("更新: {current} → {latest}");

    // manifest.json アセット → 対象 target の zip 名と sha256。
    let manifest: Manifest = serde_json::from_str(&get_text(
        &agent,
        &asset(&rel, "manifest.json")?.browser_download_url,
    )?)
    .context("manifest.json の解析に失敗しました")?;
    let entry = manifest
        .targets
        .iter()
        .find(|t| t.target == TARGET)
        .ok_or_else(|| anyhow!("manifest に {TARGET} 用のエントリがありません"))?;

    println!("ダウンロード中: {}", entry.asset);
    let bytes = get_bytes(&agent, &asset(&rel, &entry.asset)?.browser_download_url)
        .context("アーカイブのダウンロードに失敗しました")?;

    let got = util::sha256_hex(&bytes);
    if !got.eq_ignore_ascii_case(&entry.sha256) {
        bail!(
            "sha256 が一致しません（期待 {} / 実際 {got}）。中断しました。",
            entry.sha256
        );
    }
    println!("検証 OK（sha256）。差し替え中…");

    swap_in_place(&bytes, &install_root()?)?;
    println!("更新完了（{latest}）。次回 imgdiff 実行から反映されます。");
    Ok(())
}

fn asset<'a>(rel: &'a Release, name: &str) -> Result<&'a Asset> {
    rel.assets
        .iter()
        .find(|a| a.name == name)
        .ok_or_else(|| anyhow!("release に {name} がありません"))
}

/// インストールの束ルート（exe が `<root>/bin/imgdiff.exe` 想定 → root = 親の親）。
/// bin/ レイアウトでなければ（開発ビルド等）更新は非対応。
fn install_root() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("current_exe の取得に失敗")?;
    let bin = exe
        .parent()
        .ok_or_else(|| anyhow!("exe の親ディレクトリがありません"))?;
    if bin.file_name().and_then(|s| s.to_str()) != Some("bin") {
        bail!("同梱パッケージ（bin/ レイアウト）ではないため imgdiff update は使えません。配布 zip を展開して使ってください。");
    }
    Ok(bin
        .parent()
        .ok_or_else(|| anyhow!("bin の親ディレクトリがありません"))?
        .to_path_buf())
}

fn with_old(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(OLD_SUFFIX);
    PathBuf::from(s)
}

/// zip（先頭コンポーネント `imgdiff/` 配下）を root 配下へ rename-aside で展開・差し替える。
fn swap_in_place(zip_bytes: &[u8], root: &Path) -> Result<()> {
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).context("zip を開けません")?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        let Some(enclosed) = f.enclosed_name() else {
            continue; // 不正/危険なパスはスキップ
        };
        // 先頭コンポーネント（"imgdiff"）を剥がして root 配下へ対応付ける。
        let rel: PathBuf = enclosed.components().skip(1).collect();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let target = root.join(&rel);
        if f.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // 既存はロックされ得る（実行中の exe/DLL）。上書きでなく rename-aside し、新規を元パスへ書く。
        if target.exists() {
            let old = with_old(&target);
            let _ = std::fs::remove_file(&old); // 前回の残骸
            std::fs::rename(&target, &old).with_context(|| {
                format!(
                    "旧ファイルの退避に失敗: {}（*.imgdiff-old から手動復旧できます）",
                    target.display()
                )
            })?;
        }
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf)?;
        std::fs::write(&target, &buf)
            .with_context(|| format!("書き込み失敗: {}", target.display()))?;
    }
    Ok(())
}

/// 起動時に呼ぶ: 同梱パッケージ（bin/ レイアウト）なら前回 update で残った `*.imgdiff-old` を掃除する。
/// best-effort・失敗無視。開発ビルド（bin/ でない）では何もしない。
pub fn cleanup_old() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(bin) = exe.parent() else {
        return;
    };
    if bin.file_name().and_then(|s| s.to_str()) != Some("bin") {
        return;
    }
    let Some(root) = bin.parent() else {
        return;
    };
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        let p = entry.path();
        if p.is_file() && p.to_string_lossy().ends_with(OLD_SUFFIX) {
            let _ = std::fs::remove_file(p);
        }
    }
}
