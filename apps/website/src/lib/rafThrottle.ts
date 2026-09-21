// 進捗のような「最後の値だけが要る」更新を、フレームに 1 回へ合流させる。
// scan と convert が共有する（どちらも worker の完了ごとに呼ばれる）。

/**
 * 進捗の set をフレームに 1 回へ合流させる。
 *
 * `onProgress` は 1 件終わるごとに呼ばれ、各 worker の postMessage コールバック＝別マクロタスク
 * なので React は跨いでバッチしない。実測で小さい画像だと ~580 回/秒に達し、そのたびに
 * 画面全体が再描画される。進捗バーはフレームに 1 回で足りる。
 */
export function rafThrottle<T>(apply: (v: T) => void): ((v: T) => void) & { cancel: () => void } {
  let latest: T | null = null;
  let scheduled = 0;
  const push = (v: T): void => {
    latest = v;
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      if (latest !== null) apply(latest);
    });
  };
  // **次の実行を始める前に呼ぶこと。** 予約済みのフレームが後から発火すると、
  // 新しい実行の「0 / N」を古い値で上書きする（タブが隠れていると rAF は走らないので、
  // その窓は「戻ってくるまで」に広がる）。
  push.cancel = (): void => {
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = 0;
    latest = null;
  };
  return push;
}
