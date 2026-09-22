// 「同じ問い合わせが同時に何本も出る」を 1 本にまとめる小道具。
//
// **結果は持ち越さない**（終わったら忘れる）。キャッシュではないので、
// 返ってきた物が古くなる心配も、握り続けて memory を食う心配も無い。
// 減らせるのは「同時」のぶんだけだが、一覧の描画で効くのはまさにそこ
// （同じファイルが複数のグループに出る・捲り戻して枠が作り直される）。

/**
 * 走行中の呼び出しを鍵ごとに 1 本へまとめる。
 * 失敗も共有する（同時に頼んだ側は同じ例外を受け取る）——
 * 片方だけ再試行できても得が無く、「同じ入力に同じ答え」の方が追いやすい。
 */
export function dedupeInFlight<A extends unknown[], R>(
  keyOf: (...args: A) => string,
  run: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  const running = new Map<string, Promise<R>>();
  return (...args: A) => {
    const key = keyOf(...args);
    const found = running.get(key);
    if (found) return found;
    const started = run(...args).finally(() => running.delete(key));
    running.set(key, started);
    return started;
  };
}
