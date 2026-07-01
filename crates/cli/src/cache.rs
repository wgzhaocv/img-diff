//! SQLite を避けた純 Rust（redb）のハッシュキャッシュ。再スキャンでデコードを省く。
//! キーは**絶対パス**、`size`/`mtime`/`hashAlgo` が一致すればヒット（= 内容不変とみなす）。
//! 並列フェーズでの競合を避けるため、起動時に全件をメモリへ読み込み、書き込みは終了時に 1 トランザクション。
//!
//! 限界: size+mtime ヒューリスティック（czkawka / rsync / make と同方式）。内容が size と mtime を
//! 変えずに差し替わると陳腐なヒットになり得る（正常な保存は mtime を変えるため稀。mtime は ns 精度で照合）。
//! 厳密に再計算したいときは `--no-cache`。

use crate::error::CliError;
use anyhow::Result;
use redb::{ReadableDatabase, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// テーブル定義（値は Entry の JSON 文字列）。hashAlgo は Entry 内で持ち、名前は据え置き。
const TABLE: TableDefinition<&str, &str> = TableDefinition::new("hashes-v1");

/// キャッシュ 1 件（無効化フィールド + 計算済みハッシュ）。
#[derive(Serialize, Deserialize, Clone)]
pub struct Entry {
    pub size: u64,
    pub mtime_ns: u64,
    pub hash_algo: String,
    pub sha256: String,
    pub rgba_sha256: String,
    pub dhash: u64,
    pub width: u32,
    pub height: u32,
    pub format: String,
}

pub struct Cache {
    db: redb::Database,
    loaded: HashMap<String, Entry>,
}

impl Cache {
    /// キャッシュ DB を開き（無ければ作成）、全件をメモリへ読み込む。
    pub fn open(path: &Path) -> Result<Cache> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let db = redb::Database::create(path).map_err(|e| {
            CliError::new(
                "io_error",
                format!("キャッシュを開けません: {e}（--no-cache で回避できます）"),
            )
        })?;

        let mut loaded = HashMap::new();
        let rtxn = db.begin_read()?;
        // 初回はテーブルが無い（空として扱う）。
        if let Ok(table) = rtxn.open_table(TABLE) {
            for row in table.iter()? {
                let (k, v) = row?;
                if let Ok(entry) = serde_json::from_str::<Entry>(v.value()) {
                    loaded.insert(k.value().to_string(), entry);
                }
            }
        }
        drop(rtxn);
        Ok(Cache { db, loaded })
    }

    /// `key`（絶対パス）のキャッシュが size/mtime/hashAlgo すべて一致すれば返す（ヒット）。
    pub fn get(&self, key: &str, size: u64, mtime_ns: u64, hash_algo: &str) -> Option<&Entry> {
        self.loaded
            .get(key)
            .filter(|e| e.size == size && e.mtime_ns == mtime_ns && e.hash_algo == hash_algo)
    }

    /// 新規/更新エントリをまとめて 1 トランザクションで書き込む。
    pub fn write_all(&self, entries: &[(String, Entry)]) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let wtxn = self.db.begin_write()?;
        {
            let mut table = wtxn.open_table(TABLE)?;
            for (key, entry) in entries {
                let json = serde_json::to_string(entry)?;
                table.insert(key.as_str(), json.as_str())?;
            }
        }
        wtxn.commit()?;
        Ok(())
    }
}
