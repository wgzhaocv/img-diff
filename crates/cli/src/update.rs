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
/// 自分の配布 target（build.rs が cargo の TARGET をそのまま埋め込む）。manifest の "target" と同表記。
const TARGET: &str = env!("IMGDIFF_TARGET");
const OLD_SUFFIX: &str = ".imgdiff-old";
/// 配布 zip の先頭コンポーネント。これ以外のエントリ（`__MACOSX/` 等）は展開しない。
const ARCHIVE_ROOT: &str = "imgdiff";

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
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .build(),
        )
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
    // 差し替え先の判定は**ネットワークより先**に。同梱パッケージでなければどうせ入れられないので、
    // 数十 MB を落としきってから断るのは無駄（純粋なパス判定なので先に出しても副作用はない）。
    let root = install_root()?;
    let agent = agent();
    let current = env!("CARGO_PKG_VERSION");

    let rel: Release = serde_json::from_str(&get_text(
        &agent,
        &format!("https://api.github.com/repos/{REPO}/releases/latest"),
    )?)
    .context("最新リリース情報の取得/解析に失敗しました（未リリースかネット不通）")?;
    let latest = rel.tag_name.trim_start_matches('v').to_string();
    // latest が古い / 同版なら何もしない。プラットフォームごとにリリースがずれている間
    // （例: mac だけ先行し `releases/latest` はまだ旧版）に降格させないため、単純な不一致では判定しない。
    if !util::is_newer(&latest, current) {
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

    swap_in_place(&bytes, &root)?;
    println!("更新完了（{latest}）。次回 imgdiff 実行から反映されます。");
    Ok(())
}

fn asset<'a>(rel: &'a Release, name: &str) -> Result<&'a Asset> {
    rel.assets
        .iter()
        .find(|a| a.name == name)
        .ok_or_else(|| anyhow!("release に {name} がありません"))
}

/// インストールの束ルート（exe が `<root>/bin/imgdiff` 想定 → root = 親の親）。
/// bin/ レイアウトでなければ（開発ビルド・cargo install 等）更新は非対応。
/// 判定は [`util::bundle_root`] が正本（`decode` の VIPSHOME 決定と同じ基準を使う）。
fn install_root() -> Result<PathBuf> {
    util::bundle_root().ok_or_else(|| {
        anyhow!("同梱パッケージ（bin/ レイアウト）ではないため imgdiff update は使えません。配布アーカイブを展開して使ってください。")
    })
}

fn with_old(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(OLD_SUFFIX);
    PathBuf::from(s)
}

/// 配布アーカイブのエントリを束ルートからの相対パスへ写す。
/// 展開できないもの（不正パス・`imgdiff/` 配下でない・symlink・ルート自身）は `None`。
///
/// 先頭コンポーネントを白名単で見るのは、素通しで `skip(1)` すると macOS の zip に混じる
/// `__MACOSX/...` まで展開してしまうため。symlink は中身が「リンク先の文字列」なので、
/// 通常ファイルとして書き出すと壊れる（アーカイブの作り手が誰かに依らない、展開器側の不変条件）。
fn entry_rel_path(f: &zip::read::ZipFile<'_, impl Read>) -> Option<PathBuf> {
    let enclosed = f.enclosed_name()?;
    let mut comps = enclosed.components();
    if comps.next().map(|c| c.as_os_str()) != Some(ARCHIVE_ROOT.as_ref()) {
        return None;
    }
    if f.is_symlink() {
        return None;
    }
    let rel: PathBuf = comps.collect();
    (!rel.as_os_str().is_empty()).then_some(rel)
}

/// zip（先頭コンポーネント `imgdiff/` 配下）を root 配下へ rename-aside で展開・差し替える。
///
/// 3 段構え:
/// 1. **書き込む前に**アーカイブの中身を数え、本体が入っているか検査する。エントリを条件で弾く
///    箇所が複数あるので、これが無いと「1 つも展開しないまま更新完了と表示する」あるいは
///    「ライブラリだけ入れ替えて本体を置き換え損ねる」という壊れ方をする。
/// 2. 展開（実行中のファイルは上書きできないので rename-aside）。
/// 3. **新しいアーカイブに無くなったファイルを掃除する。** 特に `lib/vips-modules-*/` に古い
///    モジュールが残ると libvips がそれも dlopen するため、版が食い違えば誤動作する。
fn swap_in_place(zip_bytes: &[u8], root: &Path) -> Result<()> {
    let exe_rel = Path::new("bin").join(if cfg!(windows) {
        "imgdiff.exe"
    } else {
        "imgdiff"
    });
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).context("zip を開けません")?;

    // 1) 事前検査（まだ何も書かない）。
    let mut entries: Vec<(usize, PathBuf, bool)> = Vec::new(); // (索引, 相対パス, ディレクトリか)
    for i in 0..zip.len() {
        let f = zip.by_index(i)?;
        if let Some(rel) = entry_rel_path(&f) {
            let is_dir = f.is_dir();
            entries.push((i, rel, is_dir));
        }
    }
    if !entries.iter().any(|(_, rel, is_dir)| !is_dir && *rel == exe_rel) {
        bail!(
            "アーカイブに {} が含まれていません（構造が想定と異なります）。更新は行っていません。",
            exe_rel.display()
        );
    }

    // 2) 展開。
    let mut kept: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for (i, rel, is_dir) in &entries {
        let mut f = zip.by_index(*i)?;
        let target = root.join(rel);
        if *is_dir {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        kept.insert(rel.clone());
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
        // unix では実行権限を復元しないと、差し替えた imgdiff 本体が起動できなくなる。
        // mode を持たないアーカイブ（Windows 製）は unix に配られないので、その場合は触らない。
        #[cfg(unix)]
        if let Some(mode) = f.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode & 0o777))
                .with_context(|| format!("権限の設定に失敗: {}", target.display()))?;
        }
    }

    // 3) 新しい版に無くなったファイルを掃除する（best-effort）。掃除の対象は**この束が管理する
    //    bin/ と lib/ だけ**に限る（利用者が root 直下に置いた物には触らない）。
    //    退避済みの `*.imgdiff-old` は次回起動の cleanup_old が片付けるので残す。
    for managed in ["bin", "lib"] {
        let dir = root.join(managed);
        if !dir.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&dir).into_iter().flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            if p.to_string_lossy().ends_with(OLD_SUFFIX) {
                continue;
            }
            match p.strip_prefix(root) {
                Ok(rel) if !kept.contains(rel) => {
                    let _ = std::fs::remove_file(p);
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// 起動時に呼ぶ: 同梱パッケージ（bin/ レイアウト）なら前回 update で残った `*.imgdiff-old` を掃除する。
/// best-effort・失敗無視。開発ビルド（bin/ でない）では何もしない。
pub fn cleanup_old() {
    let Some(root) = util::bundle_root() else {
        return;
    };
    for entry in walkdir::WalkDir::new(&root).into_iter().flatten() {
        // 名前で先に絞る（file_type は readdir 由来で無料・is_file() は stat が走る）。
        if entry.file_name().to_string_lossy().ends_with(OLD_SUFFIX) && entry.file_type().is_file()
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{swap_in_place, ARCHIVE_ROOT};
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn exe_name() -> &'static str {
        if cfg!(windows) {
            "imgdiff.exe"
        } else {
            "imgdiff"
        }
    }

    /// `imgdiff/` を先頭に持つ zip を組み立てる（(アーカイブ内パス, 中身) の並び）。
    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().unix_permissions(0o755);
        for (name, body) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(body).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "imgdiff-update-test-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(d.join("bin")).unwrap();
        std::fs::create_dir_all(d.join("lib")).unwrap();
        d
    }

    fn write(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn replaces_bundle_and_prunes_files_absent_from_the_archive() {
        let root = scratch("prune");
        write(&root.join("bin").join(exe_name()), "old exe");
        // 旧版にしか無いモジュール。残すと libvips が古い物まで dlopen してしまう。
        write(&root.join("lib/vips-modules-8.18/vips-jxl.dylib"), "stale");
        write(&root.join("lib/libkeep.dylib"), "old");
        // 束の管理外（root 直下）には触らないこと。
        write(&root.join("README.txt"), "user file");

        let zip = make_zip(&[
            (
                &format!("{ARCHIVE_ROOT}/bin/{}", exe_name()),
                b"new exe" as &[u8],
            ),
            (&format!("{ARCHIVE_ROOT}/lib/libkeep.dylib"), b"new"),
            // macOS の zip に紛れ込む付随エントリ。展開してはいけない。
            ("__MACOSX/imgdiff/._bin", b"junk"),
        ]);

        swap_in_place(&zip, &root).unwrap();

        let exe = root.join("bin").join(exe_name());
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "new exe");
        assert_eq!(
            std::fs::read_to_string(root.join("lib/libkeep.dylib")).unwrap(),
            "new"
        );
        assert!(
            !root.join("lib/vips-modules-8.18/vips-jxl.dylib").exists(),
            "新版に無いモジュールは掃除されるべき"
        );
        assert!(root.join("README.txt").exists(), "管理外のファイルは残す");
        assert!(!root.join("imgdiff").exists(), "__MACOSX を展開してはいけない");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&exe).unwrap().permissions().mode() & 0o777,
                0o755,
                "実行権限が復元されていない"
            );
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_archive_without_the_binary_without_touching_anything() {
        let root = scratch("preflight");
        write(&root.join("bin").join(exe_name()), "old exe");
        write(&root.join("lib/libkeep.dylib"), "old");

        // 本体が入っていない（＝構造が想定外）アーカイブ。
        let zip = make_zip(&[(&format!("{ARCHIVE_ROOT}/lib/libkeep.dylib"), b"new" as &[u8])]);

        assert!(swap_in_place(&zip, &root).is_err());
        // **1 バイトも書き換わっていない**こと（検査は展開より前に済ませる）。
        assert_eq!(
            std::fs::read_to_string(root.join("bin").join(exe_name())).unwrap(),
            "old exe"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("lib/libkeep.dylib")).unwrap(),
            "old"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
