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

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// 両端で共有する golden（`tests/golden.json`）。web 側は
    /// `apps/website/tests/goldenDecode.test.ts` が**同じファイル**を読む。
    ///
    /// **`crates/wasm` の parity とは守る範囲が違う。** あちらは合成 RGBA から始まるので
    /// デコーダを 1 つも通らない ⇒ 原生 libvips と wasm-vips がずれても緑のままになる。
    /// こちらは実ファイルから始めるので、SPEC §1 の手順 1〜3 まで含めて押さえる。
    #[derive(Deserialize)]
    struct Golden {
        #[serde(rename = "hashAlgo")]
        hash_algo: String,
        images: Vec<GoldenImage>,
    }

    #[derive(Deserialize)]
    struct GoldenImage {
        file: String,
        sha256: String,
        width: u32,
        height: u32,
        dhash: String,
    }

    #[test]
    fn golden_fixtures_match() {
        decode::init().expect("libvips の初期化");
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests");
        let golden: Golden = serde_json::from_slice(
            &std::fs::read(root.join("golden.json")).expect("tests/golden.json を読む"),
        )
        .expect("tests/golden.json を解釈する");
        assert_eq!(golden.hash_algo, imgdiff_core::report::HASH_ALGO_VERSION);
        assert!(!golden.images.is_empty(), "夹具が 1 枚も無い");

        for want in &golden.images {
            let path = root.join("fixtures").join(&want.file);
            let got = decode_and_hash(&path).unwrap_or_else(|e| panic!("{}: {e}", want.file));
            // **夹具そのものが入れ替わっていないこと**を先に見る（期待値だけ直す / 夹具だけ差し替える、
            // のどちらでも「緑のまま意味が変わる」ので）。
            assert_eq!(got.sha256, want.sha256, "{}: 夹具のバイト列", want.file);
            assert_eq!(
                (got.width, got.height),
                (want.width, want.height),
                "{}: 寸法（autorot 後）",
                want.file
            );
            assert_eq!(hash::to_hex(got.dhash), want.dhash, "{}: dHash", want.file);
        }
    }
}
