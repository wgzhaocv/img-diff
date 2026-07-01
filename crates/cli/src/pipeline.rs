//! デコード+ハッシュの共通処理（scan / compare が共有）。
//! libvips デコードは CLI 専有のため core でなくここに置く。

use crate::decode;
use crate::error::CliError;
use crate::util;
use anyhow::Result;
use imgdiff_core::{hash, preprocess};
use std::path::Path;

/// 1 枚のデコード+各種ハッシュ結果（白平坦化後）。
pub struct DecodeHash {
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    /// ファイル内容の SHA-256。
    pub sha256: String,
    /// 白平坦化後の RGBA（compare はこれを保持、scan は使い終えて捨てる）。
    pub rgba: Vec<u8>,
    /// 白平坦化後 RGBA の SHA-256（pixelSha256 の候補値）。
    pub rgba_sha256: String,
    pub dhash: u64,
}

/// ファイルを読み、SPEC §1 の正規化（デコード→白平坦化）と各ハッシュを計算する。
/// 読み込み失敗は `not_found`、デコード失敗は `decode_error`（decode 側）でコード付与。
pub fn decode_and_hash(path: &Path) -> Result<DecodeHash> {
    let bytes = std::fs::read(path).map_err(|e| {
        CliError::new(
            "not_found",
            format!("{}: {e}（パスが正しいか確認してください）", path.display()),
        )
    })?;
    let sha256 = util::sha256_hex(&bytes);
    let mut dec = decode::decode_canonical(path)?;
    preprocess::flatten_on_white(&mut dec.rgba);
    let rgba_sha256 = util::sha256_hex(&dec.rgba);
    let dhash = hash::dhash_rgba(&dec.rgba, dec.width, dec.height);
    let format = path
        .extension()
        .and_then(|x| x.to_str())
        .map(util::normalize_ext)
        .unwrap_or_default();
    Ok(DecodeHash {
        bytes: bytes.len() as u64,
        width: dec.width,
        height: dec.height,
        format,
        sha256,
        rgba: dec.rgba,
        rgba_sha256,
        dhash,
    })
}
