import { describe, expect, it } from "vite-plus/test";
import type { ConvertOptions } from "schema";
import {
  cannotWriteReason,
  gravityAxes,
  matchRatio,
  gravityFromParts,
  gravityParts,
  projectGravity,
  presetWidths,
  PRESET_WIDTHS,
  qualityApplies,
  relevantControls,
  WRITABLE_FORMATS,
  type RelevanceInput,
} from "@/lib/convertControls";
import { planGeometry, saveSpec } from "@/lib/convertPlan";
import type { ConvertFit } from "schema";

// UI.md §6.1「今の条件で効かない控件は出さない」の判定表。
// 各行の根拠は実装側（workers/vips.ts の applyConvert 分岐・convertPlan.ts の saveSpec）にある。

const base: RelevanceInput = { width: "", height: "", fit: "cover", format: "" };
const sized = (patch: Partial<RelevanceInput> = {}): RelevanceInput => ({
  ...base,
  width: "800",
  height: "600",
  ...patch,
});

describe("合わせ方（fit）", () => {
  it("幅と高さが両方あるときだけ効く（SPEC §5.4 規則 2）", () => {
    expect(relevantControls(base, "png").fit).toBe(false);
    expect(relevantControls({ ...base, width: "800" }, "png").fit).toBe(false);
    expect(relevantControls({ ...base, height: "600" }, "png").fit).toBe(false);
    expect(relevantControls(sized(), "png").fit).toBe(true);
  });

  it("空白だけの入力は「指定なし」として扱う", () => {
    expect(relevantControls({ ...base, width: " ", height: " " }, "png").fit).toBe(false);
  });
});

describe("寄せる位置（gravity）", () => {
  it("cover と contain では効き、fill では効かない", () => {
    expect(relevantControls(sized({ fit: "cover" }), "png").gravity).toBe(true);
    expect(relevantControls(sized({ fit: "contain" }), "png").gravity).toBe(true);
    expect(relevantControls(sized({ fit: "fill" }), "png").gravity).toBe(false);
  });

  it("寸法が片方だけなら fit 自体が効かないので、gravity も出さない", () => {
    expect(relevantControls({ ...base, width: "800", fit: "cover" }, "png").gravity).toBe(false);
  });
});

describe("背景色（background）", () => {
  it("contain のときだけ効く（余白を埋めるのが唯一の用途）", () => {
    expect(relevantControls(sized({ fit: "contain" }), "png").background).toBe(true);
    expect(relevantControls(sized({ fit: "cover" }), "png").background).toBe(false);
    expect(relevantControls(sized({ fit: "fill" }), "png").background).toBe(false);
    expect(relevantControls({ ...base, fit: "contain" }, "png").background).toBe(false);
  });

  it("原寸が分かれば「余白が出ない contain」も出さない", () => {
    // 400×400 を 400×400 に収める＝縮小も余白も起きない ⇒ 塗る場所が無い。
    const opts = { width: "400", height: "400", fit: "contain" as const, format: "" };
    expect(relevantControls(opts, "png", { width: 400, height: 400 }).background).toBe(false);
    // 縦横比が違えば余白は出る。
    expect(relevantControls(opts, "png", { width: 800, height: 200 }).background).toBe(true);
  });
});

describe("縦横比がぴったり合っているなら合わせ方も出さない", () => {
  // 3 つの合わせ方（切り抜く / 収める / 引き伸ばす）が同じ結果になるので選ばせる意味が無い。
  // 錠（縦横比を保つ）が入っていると常にこの状態になる。
  const src = { width: 1600, height: 1200 };
  const at = (width: string, height: string) =>
    relevantControls({ width, height, fit: "cover" as const, format: "" }, "jpg", src);

  it("比が合っていれば出さない", () => {
    expect(at("400", "300").fit).toBe(false);
    expect(at("800", "600").fit).toBe(false);
  });

  it("切り抜きが起きるなら出す", () => {
    expect(at("400", "400").fit).toBe(true);
  });

  it("原寸が分からないうちは出す（起きないと証明できていない）", () => {
    expect(
      relevantControls({ width: "400", height: "300", fit: "cover", format: "" }, "jpg", null).fit,
    ).toBe(true);
  });
});

describe("原寸が分かるときは計画から答える", () => {
  const square = { width: 400, height: 400 };

  it("縦横比が同じ切り抜きは、寄せる位置ごと出さない", () => {
    const opts = { width: "200", height: "200", fit: "cover" as const, format: "" };
    const r = relevantControls(opts, "png", square);
    expect(r.gravity).toBe(false);
    expect(r.axes).toEqual({ x: false, y: false });
  });

  it("正方形を横長に切り抜くなら、効く軸は上下だけ", () => {
    const opts = { width: "200", height: "100", fit: "cover" as const, format: "" };
    const r = relevantControls(opts, "png", square);
    expect(r.gravity).toBe(true);
    expect(r.axes).toEqual({ x: false, y: true });
  });

  it("原寸が分からないうちは、効かないと証明できないので隠さない", () => {
    const opts = { width: "200", height: "100", fit: "cover" as const, format: "" };
    expect(relevantControls(opts, "png").axes).toEqual({ x: true, y: true });
    expect(relevantControls(opts, "png", { width: 0, height: 0 }).axes).toEqual({
      x: true,
      y: true,
    });
  });
});

describe("寸法欄の読み取りは parseDim が正本", () => {
  it("0 や整数でない値は「指定なし」として扱う（合わせ方も出ない）", () => {
    expect(relevantControls({ ...base, width: "0", height: "100" }, "").fit).toBe(false);
    expect(relevantControls({ ...base, width: "1.5", height: "100" }, "").fit).toBe(false);
    expect(relevantControls({ ...base, width: "abc", height: "100" }, "").fit).toBe(false);
    expect(relevantControls({ ...base, width: "1", height: "100" }, "").fit).toBe(true);
  });
});

describe("画質（quality）", () => {
  it("Q を受け取る形式でだけ効く", () => {
    for (const f of ["jpg", "webp", "avif", "jxl"]) {
      expect(relevantControls({ ...base, format: f }, "png").quality, f).toBe(true);
    }
    for (const f of ["png", "tiff", "gif", "ppm"]) {
      expect(relevantControls({ ...base, format: f }, "jpg").quality, f).toBe(false);
    }
  });

  it("別名で書かれた形式も正規化して判定する", () => {
    expect(relevantControls({ ...base, format: "jpeg" }, "").quality).toBe(true);
    expect(relevantControls({ ...base, format: "tif" }, "").quality).toBe(false);
  });

  it("「入力と同じ」なら入力の形式で判定する", () => {
    expect(relevantControls(base, "gif").quality).toBe(false);
    expect(relevantControls(base, "jpeg").quality).toBe(true);
    expect(relevantControls(base, "").quality).toBe(false);
  });

  it("「入力と同じ」でも、書き出せない形式なら出さない（その指定は必ず失敗するため）", () => {
    // heic も svg も libvips では書けない ⇒ 出力形式が入力と同じなら画質を出す理由がない。
    expect(relevantControls(base, "heic").quality).toBe(false);
    expect(relevantControls(base, "svg").quality).toBe(false);
  });
});

describe("qualityApplies は saveSpec を唯一の正本にしている", () => {
  it("書ける形式すべてで saveSpec の Q の有無と一致する", () => {
    for (const f of WRITABLE_FORMATS) {
      expect(qualityApplies(f), f).toBe("Q" in saveSpec(f, 80)!.options);
    }
  });
});

describe("寄せる位置が効く軸", () => {
  const axesFor = (srcW: number, srcH: number, w: number, h: number, fit: ConvertFit) =>
    gravityAxes(planGeometry({ srcW, srcH, width: w, height: h, fit, gravity: "center" }));

  it("正方形を横長に切り抜くと、効くのは上下だけ", () => {
    // 400×400 を 200×100 に cover: 倍率 0.5 → 200×200 を縦に切る。横は余らない。
    expect(axesFor(400, 400, 200, 100, "cover")).toEqual({ x: false, y: true });
  });

  it("正方形を縦長に切り抜くと、効くのは左右だけ", () => {
    expect(axesFor(400, 400, 100, 200, "cover")).toEqual({ x: true, y: false });
  });

  it("縦横比が違う両方向なら両軸とも効く", () => {
    // 200×100 を 80×80 に cover: 倍率 0.8 → 160×80 を横に切る。
    expect(axesFor(200, 100, 80, 80, "cover")).toEqual({ x: true, y: false });
    // 100×200 を 80×80 なら縦に切る。
    expect(axesFor(100, 200, 80, 80, "cover")).toEqual({ x: false, y: true });
  });

  it("縦横比が同じなら切り取りが起きず、どちらの軸も効かない", () => {
    expect(axesFor(400, 200, 200, 100, "cover")).toEqual({ x: false, y: false });
  });

  it("収める（contain）では余白が出る軸だけが効く", () => {
    // 400×200 を 200×200 に contain: 倍率 0.5 → 200×100 を 200×200 の画布へ。上下に余白。
    expect(axesFor(400, 200, 200, 200, "contain")).toEqual({ x: false, y: true });
    expect(axesFor(200, 400, 200, 200, "contain")).toEqual({ x: true, y: false });
  });

  it("引き伸ばす（fill）は寄せる位置を使わない", () => {
    expect(axesFor(400, 400, 200, 100, "fill")).toEqual({ x: false, y: false });
  });
});

describe("gravity の成分", () => {
  it("値の名前がそのまま <y><x> になっている", () => {
    expect(gravityParts("northwest")).toEqual({ y: "north", x: "west" });
    expect(gravityParts("west")).toEqual({ y: "", x: "west" });
    expect(gravityParts("south")).toEqual({ y: "south", x: "" });
    expect(gravityParts("center")).toEqual({ y: "", x: "" });
    expect(gravityFromParts("north", "east")).toBe("northeast");
    expect(gravityFromParts("", "")).toBe("center");
  });

  it("効かない軸の成分は中央へ寄せる（出力は同じ）", () => {
    expect(projectGravity("northwest", { x: false, y: true })).toBe("north");
    expect(projectGravity("northwest", { x: true, y: false })).toBe("west");
    expect(projectGravity("northwest", { x: true, y: true })).toBe("northwest");
    expect(projectGravity("southeast", { x: false, y: false })).toBe("center");
  });

  it("使える位置＝自分自身へ射影される位置（画面の空きマス判定と同じ規則）", () => {
    const axes = { x: false, y: true };
    const usable = (["north", "center", "south"] as const).every(
      (g) => projectGravity(g, axes) === g,
    );
    const hidden = (["west", "east", "northwest", "southeast"] as const).every(
      (g) => projectGravity(g, axes) !== g,
    );
    expect(usable && hidden).toBe(true);
  });
});

describe("よく使う幅の早押し（presetWidths）", () => {
  const w = (width: number): { width: number } => ({ width });

  it("原寸より小さい幅だけを返す", () => {
    expect(presetWidths(w(6000))).toEqual(PRESET_WIDTHS);
    expect(presetWidths(w(1000))).toEqual([828, 750, 640, 384]);
  });

  it("原寸ちょうどの幅は出さない（拡大しない縛りで何も起きない）", () => {
    expect(presetWidths(w(1920))[0]).toBe(1200);
  });

  it("階段より小さい画像や、原寸が分からないうちは何も出さない", () => {
    expect(presetWidths(w(384))).toEqual([]);
    expect(presetWidths(w(0))).toEqual([]);
    expect(presetWidths(null)).toEqual([]);
  });
});

describe("読めるが書けない形式は、押す前に理由を出す", () => {
  // 1 枚しか扱わないので、判定は `cannotWriteReason` 1 つに寄っている
  // （バッチだった頃の `validate` は「全件が駄目なときだけ止める」役だった）。
  const opts = (patch: Partial<ConvertOptions> = {}): ConvertOptions => ({
    width: 100,
    height: 100,
    fit: "cover",
    gravity: "center",
    background: null,
    format: null,
    quality: 80,
    forceReencode: false,
    ...patch,
  });

  it("heic のまま出そうとすると理由を返す（wasm-vips は heic を書けない）", () => {
    expect(cannotWriteReason(opts(), "heic")).toMatch(/書き出せません/);
  });

  it("出力形式を指定すれば通る", () => {
    expect(cannotWriteReason(opts({ format: "jpg" }), "heic")).toBeNull();
  });
});

describe("縦横比の錠（matchRatio）", () => {
  const src = { width: 1024, height: 768 };

  it("片方から他方を出す", () => {
    expect(matchRatio(src, "width", 400)).toBe(300);
    expect(matchRatio(src, "height", 300)).toBe(400);
  });

  it("正方形なら同じ値", () => {
    expect(matchRatio({ width: 1024, height: 1024 }, "width", 828)).toBe(828);
  });

  it("四捨五入する（1px はずれる・隠さない）", () => {
    // 1023×768 の幅 400 → 300.29…。整数比だけ許す方が使えないので丸める。
    expect(matchRatio({ width: 1023, height: 768 }, "width", 400)).toBe(300);
  });

  it("極端に細くしても 1px は残す（0 は寸法として無効）", () => {
    expect(matchRatio({ width: 4000, height: 10 }, "width", 100)).toBe(1);
  });

  it("原寸が分からない・値が正でないときは書き戻さない", () => {
    expect(matchRatio(null, "width", 400)).toBeNull();
    expect(matchRatio({ width: 0, height: 0 }, "width", 400)).toBeNull();
    expect(matchRatio(src, "width", 0)).toBeNull();
    expect(matchRatio(src, "width", Number.NaN)).toBeNull();
  });
});
