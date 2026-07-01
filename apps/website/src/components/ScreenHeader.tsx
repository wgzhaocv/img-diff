import type { ReactNode } from "react";

type Props = {
  title: string;
  /** 見出し上のバッジ等（任意）。 */
  badge?: ReactNode;
  /** リード文（任意）。 */
  children?: ReactNode;
};

// 各画面の見出し（バッジ + h1 + リード文）を 1 箇所に集約。UI.md §5 のタイポ階層をここで守る。
export function ScreenHeader({ title, badge, children }: Props) {
  return (
    <header className="space-y-3 text-center">
      {badge}
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children ? <p className="mx-auto max-w-xl text-muted-foreground">{children}</p> : null}
    </header>
  );
}
