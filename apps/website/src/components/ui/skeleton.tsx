import { cn } from "@/lib/utils";

/**
 * 待っている枠（UI.md §6）。**スピナーを重ねずに、枠のまま薄く脈打たせる。**
 *
 * 動きの無効化は `index.css` の `prefers-reduced-motion` が全体に掛けてあるので、
 * reduce 指定では静止した面になる（それが正しい振る舞い）。
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
