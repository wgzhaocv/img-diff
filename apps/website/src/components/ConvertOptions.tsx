import { useEffect, useMemo } from "react";
import { Lock, LockOpen } from "lucide-react";
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
  matchRatio,
  presetWidths,
  projectGravity,
  relevantControls,
  WRITABLE_FORMATS,
  type ControlRelevance,
} from "@/lib/convertControls";
import { parseDim } from "@/lib/convertPlan";
import { cn } from "@/lib/utils";
import { extOf } from "@/lib/imagePaths";
import { DEFAULT_FORM, useConvertStore } from "@/lib/stores/convertStore";

// 変換パラメータのフォーム（SPEC §5.4 の 7 引数）。規範は UI.md §6.1。
// 値はストアが持つので、この部品は表示と入力だけを受け持つ。
//
// **どの欄が在るかは原寸に依る**ので、原寸が届いたときはこの部品ごと描き直る（1 枚につき 1 回）。
// 早押しの値だけは別部品（SizePresets）に切って、寸法欄の打鍵で網格まで巻き込まないようにしている。
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
  const srcPath = useConvertStore((s) => s.source?.path);
  const info = useConvertStore((s) => s.info);

  // **どの欄を出すかの答えはここ 1 回だけ出す**（子には真偽値だけ渡す）。
  const show = relevantControls(form, srcPath == null ? "" : extOf(srcPath), info);
  const presets = presetWidths(info);

  // 画質の欄が出ていないなら「画質を指定した」も取り消す —— 見えない設定が
  // 素通し（SPEC §5.4 規則 4）を止めて、無意味な再符号化をさせないように。
  useEffect(() => {
    if (!show.quality && form.qualityTouched) setForm({ qualityTouched: false });
  }, [show.quality, form.qualityTouched, setForm]);

  // 片方だけの指定は等比縮小になり、合わせ方の欄が消える。消えた理由をここで一言だけ言う。
  const onlyOneDim = (parseDim(form.width) == null) !== (parseDim(form.height) == null);

  /**
   * 寸法欄の編集。錠が入っていれば**触られていない側**を縦横比から書き戻す。
   * 読めない値（空・途中まで打った `1.`・0）のときは相手を動かさない ——
   * 打っている最中に勝手な数が入ると、直したいのに直せなくなる。
   */
  function editDim(edited: "width" | "height", raw: string): void {
    if (!form.lockRatio) {
      setForm({ [edited]: raw });
      return;
    }
    const n = parseDim(raw);
    const other = n == null ? null : matchRatio(info, edited, n);
    const key = edited === "width" ? "height" : "width";
    setForm(other == null ? { [edited]: raw } : { [edited]: raw, [key]: String(other) });
  }

  /** 錠を入れた瞬間に、今の寸法を縦横比へ合わせ直す（入れたのに合っていないのは嘘）。 */
  function toggleLock(on: boolean): void {
    if (!on) {
      setForm({ lockRatio: false });
      return;
    }
    const w = parseDim(form.width);
    const h = matchRatio(info, "width", w ?? 0);
    // 幅が読めない（空など）ときは合わせ直せないので、錠だけ入れる。
    setForm(h == null ? { lockRatio: true } : { lockRatio: true, height: String(h) });
  }

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
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
              onChange={(e) => editDim("width", e.target.value)}
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
              onChange={(e) => editDim("height", e.target.value)}
            />
          </div>
          <span className="pb-2 text-sm text-muted-foreground">px</span>
        </div>
        {/* **錠。** 片方を直すともう片方が縦横比から追う。既定で入っている
            （片方だけ直して意図しない切り抜きになるのが既定、というのはおかしい）。 */}
        <label className="flex w-fit items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={form.lockRatio}
            onChange={(e) => toggleLock(e.target.checked)}
          />
          {form.lockRatio ? (
            <Lock className="size-3.5 text-primary-text" aria-hidden="true" />
          ) : (
            <LockOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
          )}
          縦横比を保つ
        </label>
        <SizePresets presets={presets} lockRatio={form.lockRatio} />
        {/* 「拡大しない」だけは画面から読み取れないので残す。他は結果が見えている。 */}
        {/* 「拡大しない」は画面から読み取れない。合わせ方の欄が消えたときは、
            残っているこちら側でその理由も言う（UI.md §6.1）。 */}
        <p className="text-sm text-muted-foreground">
          拡大はしません
          {form.lockRatio && !show.fit
            ? "・縦横比を保つので切り抜きません"
            : !form.lockRatio && onlyOneDim
              ? "・片方だけなら縦横比を保ちます"
              : null}
        </p>
      </fieldset>

      {show.fit ? (
        <fieldset className="space-y-3">
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

      {show.gravity ? <GravityPad axes={show.axes} /> : null}

      {show.background ? <BackgroundField /> : null}

      <fieldset className="space-y-3">
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
        <fieldset className="space-y-3">
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
function SizePresets({ presets, lockRatio }: { presets: number[]; lockRatio: boolean }) {
  const info = useConvertStore((s) => s.info);
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
        hint: `${info.width}×${info.height}`,
        selected: width === String(info.width) && height === String(info.height),
        patch: { width: String(info.width), height: String(info.height) },
        extra: "",
      },
      ...presets.map((w) => {
        // **錠が入っていれば高さも埋める**（画面と錠の状態が食い違わないように）。
        const h = lockRatio ? matchRatio(info, "width", w) : null;
        return {
          key: String(w),
          label: String(w),
          hint: `幅 ${w} px（縦横比はそのまま）`,
          selected:
            h == null
              ? proportional && width === String(w)
              : width === String(w) && height === String(h),
          patch:
            h == null ? { width: String(w), height: "" } : { width: String(w), height: String(h) },
          extra: "num",
        };
      }),
    ];
  }, [info, lockRatio, presets, width, height]);

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
function BackgroundField() {
  const background = useConvertStore((s) => s.form.background);
  const setForm = useConvertStore((s) => s.setForm);
  return (
    <fieldset className="space-y-3">
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
function GravityPad({ axes }: { axes: ControlRelevance["axes"] }) {
  const gravity = useConvertStore((s) => s.form.gravity);
  const setForm = useConvertStore((s) => s.setForm);
  // 効かない軸の成分を落とした同義の値を選択中として見せる（出力は完全に同じ）。
  const selected = projectGravity(gravity, axes);
  return (
    <fieldset className="space-y-3">
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
