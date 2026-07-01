# imgdiff Windows インストーラ。
# GitHub Releases の最新版から自己完結パッケージ(zip)を取得し、%LOCALAPPDATA%\imgdiff へ展開、
# その bin をユーザ PATH に追加する。同梱 DLL 込みなので MSYS2 等の別途導入は不要。
# 使い方:  irm https://imgdiff.wgzhao.me/install.ps1 | iex
# 再実行で最新版へ入れ替え(update 代わり)にもなる。Windows PowerShell 5.1+ 想定。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest の進捗バーは巨大 DL を極端に遅くするため無効化
# コンソール出力を UTF-8 に(cmd 既定コードページでの日本語文字化け対策)。失敗しても続行。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$repo   = 'wgzhaocv/img-diff'
$target = 'x86_64-pc-windows-gnu'
$base   = "https://github.com/$repo/releases/latest/download"
$dest   = Join-Path $env:LOCALAPPDATA 'imgdiff'   # 展開先ルート(zip 先頭の imgdiff/ がここに載る)
$binDir = Join-Path $dest 'bin'

Write-Host "imgdiff をインストールします..." -ForegroundColor Cyan

# 1) 最新リリースの manifest.json から、対象 target の zip 名と sha256 を得る。
$manifest = Invoke-RestMethod "$base/manifest.json"
$entry = $manifest.targets | Where-Object { $_.target -eq $target } | Select-Object -First 1
if (-not $entry) { throw "manifest に $target 用のエントリがありません" }
$version = $manifest.version
Write-Host "  版 $version / 資産 $($entry.asset)"

# 2) zip を一時ファイルへダウンロード。
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) $entry.asset
Write-Host "  ダウンロード中..."
Invoke-WebRequest "$base/$($entry.asset)" -OutFile $tmp

# 3) sha256 検証(Get-FileHash は大文字。manifest は小文字なので大文字化して比較)。
$got = (Get-FileHash $tmp -Algorithm SHA256).Hash
if ($got -ne $entry.sha256.ToUpper()) {
    Remove-Item $tmp -Force
    throw "sha256 が一致しません(期待 $($entry.sha256) / 実際 $got)。中断しました。"
}
Write-Host "  検証 OK (sha256)"

# 4) 既存を消して展開。zip は先頭に imgdiff/ を含むため、親(=%LOCALAPPDATA%)へ展開すると
#    %LOCALAPPDATA%\imgdiff\bin\imgdiff.exe というレイアウトになる(update の想定と一致)。
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Expand-Archive -Path $tmp -DestinationPath $env:LOCALAPPDATA -Force
Remove-Item $tmp -Force

# 5) bin をユーザ PATH に追加(既にあれば触らない)。現在のセッションにも即反映。
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$binDir;$userPath" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "  ユーザ PATH に追加: $binDir"
}
if ($env:Path -notlike "*$binDir*") { $env:Path = "$binDir;$env:Path" }

Write-Host ""
Write-Host "完了。imgdiff $version を $dest に導入しました。" -ForegroundColor Green
Write-Host "動作確認(新しいターミナルでも可):"
& (Join-Path $binDir 'imgdiff.exe') --version
Write-Host "使い方は  imgdiff --help  / AI 手册は  imgdiff skill"
