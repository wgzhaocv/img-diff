import { useEffect, useMemo } from "react";
import type { ConvertFit, ConvertGravity } from "schema";
import { buttonVariants } from "@/components/ui/button";
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
import {
  FIT_VALUES,
  GRAVITY_VALUES,
  presetWidths,
  projectGravity,
  relevantControls,
  WRITABLE_FORMATS,
  type ControlRelevance,
} from "@/lib/convertControls";
import { parseDim } from "@/lib/convertPlan";
import { cn } from "@/lib/utils";
import { extOf } from "@/lib/imagePaths";
import { DEFAULT_FORM, representativePath, useConvertStore } from "@/lib/stores/convertStore";

// 変換パラメータのフォーム（SPEC §5.4 の 7 引数）。規範は UI.md §6.1。
// 値はストアが持つので、この部品は表示と入力だけを受け持つ。
//
// 購読するのは `form` と `sources` だけ（どちらも利用者の操作でしか変わらない）。
// サムネの到着で毎回描き直さないよう、原寸に関わる部分は別部品（SizePresets）に切ってある。
//
// **今の指定で効かない欄は描かない**（UI.md §6.1）。どれが効くかの判定は
// `lib/convertControls.ts` に集約してあり、ここでは真偽値を見るだけにする。
// 隠しても `form` の値は消さないので、条件が戻れば前の入力がそのまま復活する。

const FIT_LABEL: Record<ConvertFit, string> = {
  cover: "切り抜く",
  contain: "収める",
  fill: "引き伸ばす",
};

const GRAVITY_LABEL: Record<ConvertGravity, string> = {
  northwest: "左上",
  north: "上",
  northeast: "右上",
  west: "左",
  center: "中央",
  east: "右",
  southwest: "左下",
  south: "下",
  southeast: "右下",
};

export function ConvertOptions() {
  const form = useConvertStore((s) => s.form);
  const setForm = useConvertStore((s) => s.setForm);
  const sources = useConvertStore((s) => s.sources);
  const disabled = useConvertStore((s) => s.status === "converting");
  const sourceInfo = useConvertStore((s) => s.sourceInfo);

  // 入力にある拡張子の集合。「入力と同じ形式」のときに画質が効くかの判定に要る。
  const srcFormats = useMemo(() => [...new Set(sources.map((s) => extOf(s.path)))], [sources]);
  // 原寸の集計は**1 回の走査で済ませる**。`sourceInfo` はサムネ 1 枚ごとに作り直されるので
  // （N 枚で N 回）、ここを 2 周すると N² 回の引きになる。
  //
  // 2 つの答えを出す。`known` は**取れているぶん**、`all` は**全部揃っているときだけ**。
  // 早押しの幅は取れているぶんから出してよいが、控件を隠す判断は全部揃うまで待つ ——
  // 設定はバッチ全体に掛かるので、代表 1 枚だけで隠すと他の画像を黙って切り落とし得る。
  const { known, all } = useMemo(() => {
    const infos = sources.map((s) => sourceInfo.get(s.path));
    const known = infos.flatMap((i) =>
      i != null && i.width > 0 ? [{ width: i.width, height: i.height }] : [],
    );
    return { known, all: known.length === infos.length ? known : null };
  }, [sources, sourceInfo]);
  // **どの欄を出すかの答えはここ 1 回だけ出す**（子には真偽値だけ渡す）。
  const show = useMemo(() => relevantControls(form, srcFormats, all), [form, srcFormats, all]);
  const presets = useMemo(() => presetWidths(known), [known]);

  // 画質の欄が出ていないなら「画質を指定した」も取り消す —— 見えない設定が
  // 素通し（SPEC §5.4 規則 4）を止めて、無意味な再符号化をさせないように。
  useEffect(() => {
    if (!show.quality && form.qualityTouched) setForm({ qualityTouched: false });
  }, [show.quality, form.qualityTouched, setForm]);

  // 片方だけの指定は等比縮小になり、合わせ方の欄が消える。消えた理由をここで一言だけ言う。
  const onlyOneDim = (parseDim(form.width) == null) !== (parseDim(form.height) == null);

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
              onChange={(e) => setForm({ width: e.target.value })}
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
              onChange={(e) => setForm({ height: e.target.value })}
            />
          </div>
          <span className="pb-2 text-sm text-muted-foreground">px</span>
        </div>
        <SizePresets presets={presets} />
        {/* 「拡大しない」だけは画面から読み取れないので残す。他は結果が見えている。 */}
        <p className="text-sm text-muted-foreground">
          拡大はしません{onlyOneDim ? "・片方だけなら縦横比を保ちます" : null}
        </p>
      </fieldset>

      {show.fit ? (
        <fieldset className="space-y-3" disabled={disabled}>
          <legend className="text-sm font-medium">合わせ方</legend>
          <Tabs value={form.fit} onValueChange={(v) => setForm({ fit: v as ConvertFit })}>
            <TabsList>
              {FIT_VALUES.map((f) => (
                <TabsTrigger key={f} value={f}>
                  {FIT_LABEL[f]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </fieldset>
      ) : null}

      {show.gravity ? <GravityPad disabled={disabled} axes={show.axes} /> : null}

      {show.background ? <BackgroundField disabled={disabled} /> : null}

      <fieldset className="space-y-3" disabled={disabled}>
        <legend className="text-sm font-medium">出力形式</legend>
        <Select
          value={form.format}
          onValueChange={(v) => setForm({ format: v === "same" ? "" : v })}
        >
          <SelectTrigger id="cv-fm" aria-label="出力形式" className="w-40">
            <SelectValue placeholder="入力と同じ" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="same">入力と同じ</SelectItem>
            {WRITABLE_FORMATS.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </fieldset>

      {show.quality ? (
        <fieldset className="space-y-3" disabled={disabled}>
          <legend className="text-sm font-medium">画質</legend>
          <div className="max-w-sm space-y-2">
            <Label htmlFor="cv-q">
              値 <span className="font-mono tabular-nums text-foreground">{form.quality}</span>
            </Label>
            <Slider
              id="cv-q"
              min={1}
              max={100}
              step={1}
              value={[form.quality]}
              onValueChange={([v]) =>
                // 触ったこと自体が「同じ形式でも再圧縮する」という指定になる。
                setForm({ quality: v ?? DEFAULT_FORM.quality, qualityTouched: true })
              }
            />
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

/**
 * よく使う幅の早押し（`PRESET_WIDTHS`）と「原寸」。**打たせる前に押させる**。
 *
 * 数字を押すと**高さを空にする** —— 幅だけの指定は等比縮小なので、どの縦横比の画像でも歪まない
 * （Next.js の `Image` が `srcset` を焼き分けるのと同じ意味論）。ついでに合わせ方・寄せる位置・
 * 背景色が効かなくなるので、画面もそのぶん静かになる。
 *
 * 原寸の数値は文字で出さない: プレビューの「変換前」が同じ数字を出している（UI.md §6.1）。
 */
function SizePresets({ presets }: { presets: number[] }) {
  const first = useConvertStore(representativePath);
  const info = useConvertStore((s) => (first == null ? undefined : s.sourceInfo.get(first)));
  const multiple = useConvertStore((s) => s.sources.length > 1);
  const width = useConvertStore((s) => s.form.width);
  const height = useConvertStore((s) => s.form.height);
  const setForm = useConvertStore((s) => s.setForm);

  const choices = useMemo(() => {
    if (!info || info.width <= 0) return [];
    // 幅だけの指定＝等比。高さが入っていたらその幅は「選ばれている」ことにならない。
    const proportional = height.trim() === "";
    return [
      {
        key: "original",
        label: "原寸",
        // 代表 1 枚の寸法をバッチ全体へ入れる値なので、どの画像の原寸かを言っておく。
        hint: multiple
          ? `プレビューに使っている画像の原寸 ${info.width}×${info.height}`
          : `${info.width}×${info.height}`,
        selected: width === String(info.width) && height === String(info.height),
        patch: { width: String(info.width), height: String(info.height) },
        extra: "",
      },
      ...presets.map((w) => ({
        key: String(w),
        label: String(w),
        hint: `幅 ${w} px（縦横比はそのまま）`,
        selected: proportional && width === String(w),
        patch: { width: String(w), height: "" },
        extra: "num",
      })),
    ];
  }, [info, multiple, presets, width, height]);

  if (choices.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="よく使う寸法">
      {choices.map((c) => (
        <button
          key={c.key}
          type="button"
          role="radio"
          aria-checked={c.selected}
          aria-label={c.hint}
          title={c.hint}
          onClick={() => setForm(c.patch)}
          className={chipClass(c.selected, c.extra)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 押して選ぶ小さなボタンの見た目（寸法の早押しと寄せる位置の 3×3 が共有する）。
 * 選択は**面 + 太字 + リング**で示す＝色だけに頼らない（UI.md §7）。
 */
function chipClass(selected: boolean, extra: string): string {
  return cn(
    // **寸法も枠も既定のボタンから貰う**（自前で書くと焦点リングと無効時の見た目が落ちる）。
    buttonVariants({ variant: selected ? "secondary" : "outline" }),
    selected
      ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
      : "font-normal text-muted-foreground",
    extra,
  );
}

/**
 * 背景色。出すかどうか（＝余白が本当に出るか）は `relevantControls` が決める。
 */
function BackgroundField({ disabled }: { disabled: boolean }) {
  const background = useConvertStore((s) => s.form.background);
  const setForm = useConvertStore((s) => s.setForm);
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium">背景色</legend>
      <div className="space-y-2">
        <Input
          id="cv-bg"
          aria-label="背景色"
          placeholder="transparent / average / ffffff"
          className="w-64 font-mono"
          value={background}
          onChange={(e) => setForm({ background: e.target.value })}
        />
      </div>
    </fieldset>
  );
}

/**
 * 寄せる位置の 3×3。**余りが出ない軸のボタンは置かない**
 * （正方形を横長に切り抜くなら上下だけが効き、左右を変えても出力は 1 ピクセルも変わらない）。
 * 置かない枠には空きマスを入れる＝ 9 マスの形は保つ: 形が崩れると、どれがどの向きなのか分からなくなる。
 */
function GravityPad({ disabled, axes }: { disabled: boolean; axes: ControlRelevance["axes"] }) {
  const gravity = useConvertStore((s) => s.form.gravity);
  const setForm = useConvertStore((s) => s.setForm);
  // 効かない軸の成分を落とした同義の値を選択中として見せる（出力は完全に同じ）。
  const selected = projectGravity(gravity, axes);
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium">寄せる位置</legend>
      <div className="grid w-fit grid-cols-3 gap-2" role="radiogroup" aria-label="寄せる位置">
        {GRAVITY_VALUES.map((g) =>
          // 効かない位置は**空きマス**にする（無効なボタンを置くと読み上げにも tab にも現れる）。
          projectGravity(g, axes) === g ? (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={selected === g}
              onClick={() => setForm({ gravity: g })}
              className={chipClass(selected === g, "w-20")}
            >
              {GRAVITY_LABEL[g]}
            </button>
          ) : (
            <span key={g} className="h-9 w-20" />
          ),
        )}
      </div>
    </fieldset>
  );
}
