import { useCallback, useEffect, useState } from "react";

// 依存なしの最小ハッシュルータ。scan / compare / install の 3 画面のみ。
// SPA（Cloudflare Workers Static Assets の single-page-application）と相性が良く、
// 「速さがブランド」（UI.md §3）の方針で react-router 等は入れない。

export type View = "scan" | "compare" | "install";

const VIEWS: readonly View[] = ["scan", "compare", "install"];

function parseHash(): View {
  const raw = window.location.hash.replace(/^#\/?/, "");
  return (VIEWS as readonly string[]).includes(raw) ? (raw as View) : "scan";
}

/// 現在の画面とナビゲート関数を返す。ハッシュ変更（戻る/進む含む）に追従する。
export function useHashView(): { view: View; navigate: (view: View) => void } {
  const [view, setView] = useState<View>(parseHash);

  useEffect(() => {
    const onChange = () => setView(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next: View) => {
    window.location.hash = `#/${next}`;
  }, []);

  return { view, navigate };
}
