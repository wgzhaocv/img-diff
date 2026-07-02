import { useCallback, useEffect, useState } from "react";

// 依存なしの最小ルータ。scan / compare / install の 3 画面のみ。History API（クリーンな
// パス /compare 等・`#` なし）を使う。Cloudflare Workers Static Assets の
// not_found_handling="single-page-application" が未知パスに index.html を返すので、
// 直リンク（/compare をリロード）も成立する。「速さがブランド」（UI.md §3）で react-router は入れない。

export type View = "scan" | "compare" | "install";

const VIEWS: readonly View[] = ["scan", "compare", "install"];

function parsePath(): View {
  const seg = window.location.pathname.replace(/^\/+/, "").split("/")[0];
  return (VIEWS as readonly string[]).includes(seg) ? (seg as View) : "scan";
}

/// 現在の画面とナビゲート関数を返す。戻る/進む（popstate）に追従する。
export function useRoute(): { view: View; navigate: (view: View) => void } {
  const [view, setView] = useState<View>(parsePath);

  useEffect(() => {
    const onPop = () => setView(parsePath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((next: View) => {
    if (parsePath() !== next) window.history.pushState(null, "", `/${next}`);
    setView(next);
  }, []);

  return { view, navigate };
}
