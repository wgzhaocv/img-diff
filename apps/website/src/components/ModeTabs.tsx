import { Images, ScanSearch, type LucideIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { View } from "@/lib/router";

type Mode = { value: Exclude<View, "install">; label: string; Icon: LucideIcon };

// モード定義は 1 箇所（desktop / mobile の二重定義を避ける）。
const MODES: Mode[] = [
  { value: "scan", label: "フォルダ査重", Icon: ScanSearch },
  { value: "compare", label: "2枚を比較", Icon: Images },
];

type Props = {
  view: View;
  onNavigate: (view: View) => void;
  className?: string;
  /** 狭い画面用にトリガを均等幅にする。 */
  fullWidth?: boolean;
};

export function ModeTabs({ view, onNavigate, className, fullWidth }: Props) {
  return (
    <Tabs value={view} onValueChange={(v) => onNavigate(v as View)} className={className}>
      <TabsList className={cn(fullWidth && "w-full")}>
        {MODES.map(({ value, label, Icon }) => (
          <TabsTrigger key={value} value={value} className={cn("gap-1.5", fullWidth && "flex-1")}>
            <Icon className="size-4" />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
