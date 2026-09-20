/// バイト数を人間可読な単位に（等幅数字で表示する前提。UI.md 原則3）。
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * 例外を表示できる文字列にする。`Error` 以外（worker 越しに来た値・throw された文字列）も扱う。
 * toast の説明にも `ConvertItem.error` のような**報告に載る値**にも使うので 1 箇所に置く。
 */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
