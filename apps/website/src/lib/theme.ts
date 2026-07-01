import { useSyncExternalStore } from "react";

// テーマ切替。単一ソース = DOM の .dark クラス（index.html の inline script が初期確定）。
// useSyncExternalStore で購読することで、App でも Toaster でも同じ状態を見て、
// 切替が全購読者へ伝播する（各所で useState を持つと状態が分裂し追従しない問題を回避）。

export type Theme = "light" | "dark";

const STORAGE_KEY = "imgdiff-theme";
const listeners = new Set<() => void>();

function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function setTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage 不可（プライベートモード等）でも致命ではない。セッション内は反映される。
  }
  listeners.forEach((notify) => notify());
}

function toggleTheme(): void {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/// 現在のテーマと切替関数を返す。全呼び出しが単一ソースを共有する。
export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore<Theme>(subscribe, currentTheme, () => "light");
  return { theme, toggle: toggleTheme };
}
