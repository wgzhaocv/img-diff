import { FolderOpen, Layers, ScanLine, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropZone } from "@/components/DropZone";
import { ScreenHeader } from "@/components/ScreenHeader";

const FEATURES = [
  {
    icon: ScanLine,
    title: "3 段の厳密度",
    body: "完全一致・ピクセル一致・見た目が近い（知覚ハッシュ）で絞り込み。",
  },
  {
    icon: Layers,
    title: "グループで整理",
    body: "重複をまとめ、残す 1 枚を自動選定。削減できる容量も表示。",
  },
  {
    icon: Trash2,
    title: "安全に削除",
    body: "既定はドライラン。実削除はゴミ箱送りのみで、いつでも復元可能。",
  },
];

export function ScanScreen() {
  // Phase 1 は骨格。デコード＋ハッシュの結線は Phase 2/3。
  const notImplemented = () =>
    toast.info("スキャン処理は準備中です", {
      description: "デコード＋ハッシュ（Phase 2/3）で有効化されます。",
    });

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <ScreenHeader
        title="フォルダ内の重複・類似画像を探す"
        badge={
          <Badge variant="secondary" className="gap-1.5">
            <ShieldCheck className="size-3.5 text-primary" />
            ブラウザ内で完結・画像は送信しない
          </Badge>
        }
      >
        数百〜数千枚から、完全一致・ピクセル一致・見た目が近い画像をグループにまとめます。
      </ScreenHeader>

      <DropZone
        icon={<FolderOpen className="size-6" />}
        title="フォルダをドラッグ、または選択"
        hint="対応: Chromium 系ブラウザ（フォルダ権限）。他は個別ファイル選択にフォールバック。"
      >
        <Button onClick={notImplemented} className="gap-1.5">
          <FolderOpen className="size-4" />
          フォルダを選ぶ
        </Button>
      </DropZone>

      <div className="grid gap-4 sm:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <Card key={title}>
            <CardHeader>
              <Icon className="size-5 text-primary" />
              <CardTitle className="mt-2 text-sm">{title}</CardTitle>
              <CardDescription>{body}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
