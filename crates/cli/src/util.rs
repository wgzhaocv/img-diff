//! CLI 共通の小ユーティリティ（scan / compare / clean が共有）。

use imgdiff_core::report::{Producer, HASH_ALGO_VERSION};
use std::path::PathBuf;

/// 同梱パッケージ（配布 zip）のルートを返す。判定は **`<root>/bin/<exe>` レイアウトかどうか** の一点。
///
/// `imgdiff update`（差し替え先の特定）と `decode::init`（VIPSHOME の決定）が**同じ判定**を使うための
/// 唯一の正本。開発ビルド（`target/release/imgdiff`）や `cargo install`（`~/.cargo/bin/imgdiff`）では
/// bin/ の親が束ルートではないので、呼び出し側は**さらに用途ごとの条件**を課すこと
/// （update は「bin/ でなければ非対応」、VIPSHOME は「モジュールディレクトリが実在するか」）。
///
/// macOS の `current_exe()` は `_NSGetExecutablePath` をそのまま返し**シンボリックリンクを解決しない**。
/// `~/.local/bin/imgdiff -> <root>/bin/imgdiff` のような配置だと親が偶然 `bin` になり誤検出するため、
/// 先に `canonicalize` する（失敗時は原値で続行＝best-effort）。
pub fn bundle_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe = strip_verbatim(std::fs::canonicalize(&exe).unwrap_or(exe));
    let bin = exe.parent()?;
    if bin.file_name()? != "bin" {
        return None;
    }
    Some(bin.parent()?.to_path_buf())
}

/// Windows の `canonicalize` が返す `\\?\` 前置き（verbatim path）を剥がす。
///
/// **この道は `VIPSHOME` として libvips（C）へ渡る。** libvips は `g_build_filename` で
/// 素直に繋ぐだけなので `\\?\C:\...` を解釈できず、モジュール置き場を見失う
/// ＝ **HEIC が「未対応の形式」になる**（wine 上で実際にそうなった）。
/// verbatim でなくなることで長い道の上限（260 文字）が戻るが、
/// 同梱パッケージの置き場としては現実的な制約ではない。
fn strip_verbatim(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// この CLI の Producer（app="cli"・バージョンは本クレート・vips 実体・ハッシュ手順）。
/// scan / compare / clean で共有する。`env!("CARGO_PKG_VERSION")` は**本クレート**の版を指すため、
/// この構築を core へ移すと版がずれる点に注意（意図的に CLI 側に置く）。
pub fn cli_producer() -> Producer {
    Producer {
        app: "cli".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        vips: crate::decode::vips_version_string(),
        hash_algo: HASH_ALGO_VERSION.to_string(),
    }
}

/// `latest` が `current` より**新しい**ときだけ真（同版・古い版は偽）。
///
/// 文字列の不一致で判定すると、プラットフォームごとにリリースがずれている間（例: mac だけ先に 0.1.5 を
/// 出し、`releases/latest` はまだ 0.1.4）に「新しい版 0.1.4 があります」と**降格を勧めて**しまう。
/// 依存を増やさずドット区切りの数値列として比較する（数値でない要素は 0 扱い＝ pre-release 表記は
/// 無視して本体の数値だけ見る）。
pub fn is_newer(latest: &str, current: &str) -> bool {
    /// ドット区切りの数値列。**末尾の 0 は落とす**ので "0.1" と "0.1.0" が同値になり、
    /// あとは `Vec<u64>` の辞書順比較がそのまま版の新旧になる。
    fn parts(v: &str) -> Vec<u64> {
        let mut p: Vec<u64> = v
            .split('.')
            .map(|s| {
                let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
                s[..end].parse().unwrap_or(0)
            })
            .collect();
        while p.last() == Some(&0) {
            p.pop();
        }
        p
    }
    parts(latest) > parts(current)
}

/// バイト列の SHA-256 を小文字 16 進 64 文字で返す（定義は core に集約＝CLI/web/wasm で drift しない）。
pub fn sha256_hex(bytes: &[u8]) -> String {
    imgdiff_core::hash::sha256_hex(bytes)
}

/// 拡張子を正規化（小文字化、jpg→jpeg）。ImageRecord.format に使う簡易判定。
pub fn normalize_ext(ext: &str) -> String {
    let e = ext.to_lowercase();
    if e == "jpg" {
        "jpeg".to_string()
    } else {
        e
    }
}

/// 現在時刻を UTC の RFC3339（`YYYY-MM-DDTHH:MM:SSZ`）で返す。依存追加を避けた自前変換。
/// （Howard Hinnant の civil_from_days アルゴリズム。)
pub fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86400);
    let tod = secs.rem_euclid(86400);
    let (hh, mm, ss) = (tod / 3600, (tod % 3600) / 60, tod % 60);

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

#[cfg(test)]
mod tests {
    use super::{is_newer, strip_verbatim};
    use std::path::PathBuf;

    #[test]
    fn newer_only_when_strictly_greater() {
        assert!(is_newer("0.1.5", "0.1.4"));
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.4", "0.1.4"));
        // 手元が先行している状態（プラットフォーム別リリースのずれ）で降格を勧めない。
        assert!(!is_newer("0.1.4", "0.1.5"));
    }

    /// Windows の `canonicalize` が返す `\\?\` 前置きを剥がす。
    /// **剥がし忘れると HEIC が読めなくなる** —— この道は `VIPSHOME` として libvips（C）へ渡り、
    /// あちらは verbatim path を解釈できないのでモジュール置き場を見失う（wine で実際に起きた）。
    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\imgdiff\bin\imgdiff.exe")),
            PathBuf::from(r"C:\imgdiff\bin\imgdiff.exe")
        );
        // 前置きが無ければそのまま（unix の道は一切触らない）。
        assert_eq!(
            strip_verbatim(PathBuf::from("/opt/imgdiff/bin/imgdiff")),
            PathBuf::from("/opt/imgdiff/bin/imgdiff")
        );
        // UNC（`\\?\UNC\server\share`）は**剥がさない** —— 素の `UNC\...` は道として成り立たない。
        let unc = PathBuf::from(r"\\?\UNC\server\share\imgdiff\bin\imgdiff.exe");
        assert_eq!(strip_verbatim(unc.clone()), PathBuf::from(r"UNC\server\share\imgdiff\bin\imgdiff.exe"));
    }

    #[test]
    fn missing_and_non_numeric_components_are_zero() {
        assert!(is_newer("0.2", "0.1.9"));
        assert!(!is_newer("0.1", "0.1.0"));
        assert!(is_newer("0.1.5", "0.1"));
        // pre-release 表記は数値部分だけ見る（0.1.5-rc1 は 0.1.5 と同値扱い）。
        assert!(!is_newer("0.1.5-rc1", "0.1.5"));
        assert!(is_newer("0.1.5-rc1", "0.1.4"));
    }
}
