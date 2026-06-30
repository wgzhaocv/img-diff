use clap::{Parser, ValueEnum};
use std::path::PathBuf;
use walkdir::WalkDir;

/// 重複・類似画像を検索する
#[derive(Parser, Debug)]
#[command(name = "imgdiff", version, about = "重複・類似画像を検索する")]
struct Cli {
    /// スキャン対象のフォルダ
    folder: PathBuf,

    /// 厳密度: exact(SHA 完全一致) | pixel(ピクセル一致) | perceptual(知覚的に類似)
    #[arg(long, value_enum, default_value_t = Strict::Perceptual)]
    strict: Strict,

    /// ハミング距離のしきい値（perceptual のみ有効。0 = 指紋一致、大きいほど緩い）
    #[arg(long, default_value_t = 10)]
    threshold: u32,

    /// サブディレクトリを再帰的に探索する
    #[arg(long, default_value_t = true)]
    recurse: bool,

    /// カンマ区切りの拡張子
    #[arg(long, default_value = "jpg,jpeg,png,webp,gif,bmp,tiff")]
    ext: String,

    /// JSON レポートを出力する
    #[arg(long)]
    json: Option<PathBuf>,

    /// 自己完結型の HTML レポートを出力する（web のレンダリングを再利用）
    #[arg(long)]
    html: Option<PathBuf>,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum Strict {
    /// バイト単位。デコード不要
    Exact,
    /// デコード後のピクセルが一致（EXIF / 再エンコードを無視）
    Pixel,
    /// 知覚ハッシュ + ハミング距離
    Perceptual,
}

fn main() {
    let cli = Cli::parse();
    let exts: Vec<String> = cli.ext.split(',').map(|s| s.trim().to_lowercase()).collect();
    let max_depth = if cli.recurse { usize::MAX } else { 1 };

    let images: Vec<PathBuf> = WalkDir::new(&cli.folder)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| exts.contains(&x.to_lowercase()))
                .unwrap_or(false)
        })
        .collect();

    println!(
        "スキャン {:?} | 厳密度 {:?} | しきい値 {} | 画像 {} 件",
        cli.folder,
        cli.strict,
        cli.threshold,
        images.len()
    );

    // TODO パイプライン:
    //   rayon で並列化 → 画像ごとに SHA + shrink-on-load で縮小デコード + image_hasher で知覚ハッシュ
    //   → 厳密度に従ってクラスタリング（SHA でグループ化 / ハミング距離で union-find）
    //   → ターミナル表 / --json / --html レポートを出力
}
