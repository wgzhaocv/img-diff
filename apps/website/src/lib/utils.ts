import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui 標準の class 合成ユーティリティ（Tailwind の競合を解決してマージ）。
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
