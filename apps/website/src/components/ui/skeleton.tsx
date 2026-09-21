import { cn } from "@/lib/utils";

/**
 * 待っている枠（UI.md §6）。面の上を光が一方向に流れる（shimmer）。
 *
 * 動きの無効化は `index.css` の `prefers-reduced-motion` が全体に掛けてあるので、
 * reduce 指定では静止した面になる —— **だから枠だけに頼らず、何を待っているのかは
 * 必ず文字でも言うこと**（`ConvertPreview` の見出し）。
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="skeleton" className={cn("shimmer rounded-md bg-muted", className)} {...props} />
  );
}

export { Skeleton };
