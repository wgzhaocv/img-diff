import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Props = {
  icon: ReactNode;
  title: string;
  hint?: string;
  /** 操作ボタン等（任意）。 */
  children?: ReactNode;
  className?: string;
  /** ドロップされたファイル（任意。未指定ならドロップは視覚のみ）。 */
  onFiles?: (files: File[]) => void;
  /**
   * ドロップされた中身をそのまま渡す（任意。**指定すると `onFiles` より優先**）。
   * フォルダのドロップを扱いたい側だけが使う —— `dataTransfer.files` はフォルダを
   * 中身の無い項目として渡してくるので、`items` から handle を取る必要がある。
   */
  onDrop?: (data: DataTransfer) => void;
};

// ドロップ領域。ドラッグ時のハイライト + onFiles でドロップファイルを渡す。
export function DropZone({ icon, title, hint, children, className, onFiles, onDrop }: Props) {
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (onDrop) {
          onDrop(e.dataTransfer);
          return;
        }
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles?.(files);
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed",
        "bg-card px-6 py-14 text-center transition-colors",
        // ドラッグ中は色だけでなく実線化 + リングでも示す（色を唯一の手掛かりにしない）。
        over && "border-solid border-primary bg-accent ring-2 ring-ring/40",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-lg bg-accent text-primary">
        {icon}
      </div>
      <div className="space-y-1">
        <p className="text-base font-medium text-foreground">{title}</p>
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}
