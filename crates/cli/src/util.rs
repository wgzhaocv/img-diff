//! CLI 共通の小ユーティリティ（scan / compare / clean が共有）。

use imgdiff_core::report::{Producer, HASH_ALGO_VERSION};

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
