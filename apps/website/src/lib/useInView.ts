import { useEffect, useState } from "react";

// 「画面に入ったか」だけを答える小道具。重い読み込みを**見えている物に限る**ために使う。
//
// `loading="lazy"` では足りない場面のためにある: あれが遅らせるのは `<img>` の取得と
// デコードだけで、**URL を作るところまでは走ってしまう**。サムネは IndexedDB から
// Blob を引いて `createObjectURL` してから初めて `<img>` になるので、
// 一覧に数千枚あると全件ぶんの IDB 問い合わせが一斉に出る（DESIGN §3 は
// 「一覧はメタだけ読み、blob は遅延」と書いているのに、そうなっていなかった）。

/** 一画面ぶん先読みする（下へ捲った瞬間に枠が空なのを見せない）。 */
const ROOT_MARGIN = "600px";

/**
 * 要素が（ほぼ）見える位置に来たら `true` を返す。**一度 true になったら戻らない** ——
 * 捲って戻ったときに読み直しても得が無く、ちらつくだけなので。
 *
 * **要素は state で持つ**（ref ではなく）。`ref` の同一性を `useState` の setter に固定できるので、
 * 親が再描画しても React が付け外しをしない —— ここを普通の関数にすると、**再描画のたびに
 * 監視器を捨てて作り直す**（「もっと見る」を 1 回押すだけで、まだ見えていない枠のぶんだけ
 * 作り直しが走る）。購読の後始末も effect の戻り値に落ちる。
 *
 * `IntersectionObserver` が無い環境（古い webview・試験）では最初から `true`
 * ＝ 今までどおり全部読む。遅延は最適化であって、正しさの前提ではない。
 */
export function useInView<T extends Element>(): {
  ref: (el: T | null) => void;
  inView: boolean;
} {
  const [el, setEl] = useState<T | null>(null);
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (!el || inView) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { rootMargin: ROOT_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, inView]);

  return { ref: setEl, inView };
}
