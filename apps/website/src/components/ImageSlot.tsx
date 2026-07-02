import { useRef } from "react";
import { ImagePlus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/DropZone";
import { useObjectUrl } from "@/lib/useObjectUrl";
import { formatBytes } from "@/lib/format";

// compare 用の 1 枚スロット。未選択はドロップ領域、選択後はプレビュー（市松背景・object-contain で全体表示）
// + 「変更」。ドロップ / クリック選択の両対応。画像以外が来たら先頭ファイルにフォールバックしデコードで弾く。
export function ImageSlot({
  label,
  file,
  onPick,
  disabled,
}: {
  label: string;
  file: File | null;
  onPick: (file: File) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const url = useObjectUrl(file);

  function pickFrom(files: File[]): void {
    const image = files.find((f) => f.type.startsWith("image/")) ?? files[0];
    if (image) onPick(image);
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = ""; // 同じファイルを選び直せるように。
    pickFrom(files);
  }

  const input = (
    <input ref={inputRef} type="file" accept="image/*" hidden onChange={onInputChange} />
  );

  if (!file) {
    return (
      <DropZone
        icon={<ImagePlus className="size-6" />}
        title={label}
        hint="ドロップ、またはクリックで選択"
        onFiles={pickFrom}
      >
        {input}
        <Button disabled={disabled} onClick={() => inputRef.current?.click()} className="gap-1.5">
          <ImagePlus className="size-4" />
          画像を選ぶ
        </Button>
      </DropZone>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="checker aspect-video overflow-hidden rounded-md border border-border">
        {url ? <img src={url} alt={file.name} className="size-full object-contain" /> : null}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground" title={file.name}>
            {label}: {file.name}
          </p>
          <p className="num text-xs text-muted-foreground">{formatBytes(file.size)}</p>
        </div>
        {input}
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="shrink-0 gap-1.5"
        >
          <RefreshCw className="size-3.5" />
          変更
        </Button>
      </div>
    </div>
  );
}
