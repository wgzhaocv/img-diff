import { Images, Replace, ScanSearch, type LucideIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import type { RoutePath } from "@/routes";

// 「モード」＝処理画面のタブ。install は補助ページなのでヘッダ右のリンク（App.tsx）。
type ModeValue = Extract<RoutePath, "scan" | "compare" | "convert">;
type Mode = { value: ModeValue; label: string; Icon: LucideIcon };

// モード定義は 1 箇所（desktop / mobile の二重定義を避ける）。
const MODES: Mode[] = [
  { value: "scan", label: "重複を探す", Icon: ScanSearch },
  { value: "compare", label: "2枚を比較", Icon: Images },
  { value: "convert", label: "形式を変換", Icon: Replace },
];

type Props = {
  className?: string;
  /** 狭い画面用にトリガを均等幅にする。 */
  fullWidth?: boolean;
};

export function ModeTabs({ className, fullWidth }: Props) {
  const navigate = useNavigate();
  const current = useLocation().pathname.replace(/^\/+/, "").split("/")[0];

  return (
    <Tabs value={current} onValueChange={(v) => navigate(`/${v}`)} className={className}>
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
