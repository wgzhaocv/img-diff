import { memo } from "react";
import type { ConvertFit, ConvertGravity } from "schema";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_FORM, useConvertStore, type ConvertForm } from "@/lib/stores/convertStore";

// 変換パラメータのフォーム（SPEC §5.4 の 7 引数）。規範は UI.md §6.1。
// 値はストアが持つので、この部品は表示と入力だけを受け持つ。

/** 書き出せる形式（実測で確認済み。heic / bmp は libvips が書けないので出さない）。 */
const FORMATS = ["jpg", "png", "webp", "avif", "jxl", "gif", "tiff", "ppm"] as const;

const FITS: { value: ConvertFit; label: string; hint: string }[] = [
  {
    value: "cover",
    label: "切り抜く",
    hint: "指定寸法を埋めるように縮小し、はみ出た分を切り取ります。",
  },
  { value: "contain", label: "収める", hint: "縦横比を保って収め、余った部分を背景色で埋めます。" },
  { value: "fill", label: "引き伸ばす", hint: "縦横比を無視して指定寸法に合わせます。" },
];

/** 9 方向。cover の切り取り位置・contain の配置位置に効く（両方が指定されたときだけ）。 */
const GRAVITIES: { value: ConvertGravity; label: string }[] = [
  { value: "northwest", label: "左上" },
  { value: "north", label: "上" },
  { value: "northeast", label: "右上" },
  { value: "west", label: "左" },
  { value: "center", label: "中央" },
  { value: "east", label: "右" },
  { value: "southwest", label: "左下" },
  { value: "south", label: "下" },
  { value: "southeast", label: "右下" },
];

/**
 * **memo する。** 親（ConvertScreen）は進捗 tick のたびに再描画され、実測で tick は
 * 最大 ~580 回/秒に達する。memo が無いと、このフォーム（9 個の gravity ボタン + Tabs ×2 +
 * Radix Select + Slider）が毎 tick 再描画され、内部の逐字段 selector も意味を成さない。
 */
export const ConvertOptions = memo(function ConvertOptions({ disabled }: { disabled: boolean }) {
  const form = useConvertStore((s) => s.form);
  const setForm = useConvertStore((s) => s.setForm);
  const set = <K extends keyof ConvertForm>(k: K, v: ConvertForm[K]): void => setForm({ [k]: v });

  // 寸法が片方だけだと fit / gravity は効かない（SPEC §5.4 規則 2）。灰色にせず、理由を書いて示す。
  const fitActive = form.width.trim() !== "" && form.height.trim() !== "";

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3" disabled={disabled}>
        <legend className="text-sm font-medium">寸法</legend>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="cv-w">幅</Label>
            <Input
              id="cv-w"
              inputMode="numeric"
              placeholder="自動"
              className="w-28 font-mono tabular-nums"
              value={form.width}
              onChange={(e) => set("width", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cv-h">高さ</Label>
            <Input
              id="cv-h"
              inputMode="numeric"
              placeholder="自動"
              className="w-28 font-mono tabular-nums"
              value={form.height}
              onChange={(e) => set("height", e.target.value)}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            px。元より大きい値を入れても
            <strong className="font-medium text-foreground">拡大はしません</strong>。
          </p>
        </div>
      </fieldset>

      <fieldset className="space-y-3" disabled={disabled}>
        <legend className="text-sm font-medium">合わせ方</legend>
        <Tabs value={form.fit} onValueChange={(v) => set("fit", v as ConvertFit)}>
          <TabsList>
            {FITS.map((f) => (
              <TabsTrigger key={f.value} value={f.value}>
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className="text-sm text-muted-foreground">
          {FITS.find((f) => f.value === form.fit)?.hint}
          {fitActive ? null : " 幅と高さを両方指定したときだけ効きます（今は等比縮小）。"}
        </p>
      </fieldset>

      <fieldset className="space-y-3" disabled={disabled || !fitActive}>
        <legend className="text-sm font-medium">寄せる位置</legend>
        <div className="grid w-fit grid-cols-3 gap-2" role="radiogroup" aria-label="寄せる位置">
          {GRAVITIES.map((g) => (
            <button
              key={g.value}
              type="button"
              role="radio"
              aria-checked={form.gravity === g.value}
              onClick={() => set("gravity", g.value)}
              className={
                form.gravity === g.value
                  ? "h-9 w-20 rounded-md bg-secondary text-sm font-medium text-secondary-foreground ring-2 ring-primary ring-offset-1 ring-offset-background"
                  : "h-9 w-20 rounded-md border border-border text-sm text-muted-foreground hover:bg-secondary/60"
              }
            >
              {g.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-3" disabled={disabled}>
        <legend className="text-sm font-medium">出力</legend>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="cv-fm">形式</Label>
            <Select value={form.format} onValueChange={(v) => set("format", v === "same" ? "" : v)}>
              <SelectTrigger id="cv-fm" className="w-40">
                <SelectValue placeholder="入力と同じ" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="same">入力と同じ</SelectItem>
                {FORMATS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cv-bg">背景色</Label>
            <Input
              id="cv-bg"
              placeholder="形式で自動"
              className="w-40 font-mono"
              value={form.background}
              onChange={(e) => set("background", e.target.value)}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            背景は「収める」のときの余白に使います。<code className="font-mono">transparent</code> /{" "}
            <code className="font-mono">average</code> / 6 桁の 16 進数。空欄なら png・webp・tiff
            は透明、 それ以外は白。
          </p>
        </div>
        <div className="max-w-sm space-y-2">
          <Label htmlFor="cv-q">
            画質 <span className="font-mono tabular-nums text-foreground">{form.quality}</span>
          </Label>
          <Slider
            id="cv-q"
            min={1}
            max={100}
            step={1}
            value={[form.quality]}
            onValueChange={([v]) => set("quality", v ?? DEFAULT_FORM.quality)}
          />
          <p className="text-sm text-muted-foreground">png・gif・ppm では無視されます。</p>
        </div>
      </fieldset>
    </div>
  );
});
