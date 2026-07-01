import { ImagePlus } from "lucide-react";
import { DropZone } from "@/components/DropZone";
import { ScreenHeader } from "@/components/ScreenHeader";

export function CompareScreen() {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <ScreenHeader title="2 枚の画像を見比べる">
        並べて表示・ピクセル差分の重ね・<span className="num">SSIM</span> /{" "}
        <span className="num">PSNR</span> を等幅数字で。
      </ScreenHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <DropZone
          icon={<ImagePlus className="size-6" />}
          title="画像 A"
          hint="ドロップ、またはクリックで選択"
        />
        <DropZone
          icon={<ImagePlus className="size-6" />}
          title="画像 B"
          hint="ドロップ、またはクリックで選択"
        />
      </div>

      <p className="text-center text-sm text-muted-foreground">
        2 枚を読み込むと、比較結果（並列・スライダ・差分ハイライト・SSIM）を表示します。
      </p>
    </div>
  );
}
