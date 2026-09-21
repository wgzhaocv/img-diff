// convert の算術（SPEC §5.4）の回帰試験。ここが変換の判定そのものなので、
// 4 つの規則と gravity 9 方向を網羅する。vips には依存しない（純関数のみ）。

import { describe, expect, it } from "vite-plus/test";
import type { ConvertGravity } from "schema";
import {
  clampQuality,
  effectiveBackground,
  isPassThrough,
  normalizeOutFormat,
  parseHexRgb,
  backgroundVector,
  planGeometry,
  saveSpec,
} from "@/lib/convertPlan";
import { findOutputCollisions, outPathFor } from "@/lib/convert";
import { extOf, isConvertibleImage, isScannableImage, uniquePath } from "@/lib/imagePaths";
import {
  DEFAULT_FORM,
  previewKey,
  previewSettled,
  rememberedForm,
  resolveOptions,
  sanitizeStoredForm,
  useConvertStore,
} from "@/lib/stores/convertStore";

const base = { srcW: 100, srcH: 50, fit: "cover", gravity: "center" } as const;

describe("規則 1: 拡大しない", () => {
  it("目標が元より大きくても縮小も拡大もしない", () => {
    expect(planGeometry({ ...base, width: 200, height: null })).toEqual({ kind: "noop" });
    expect(planGeometry({ ...base, width: 200, height: 100 })).toEqual({ kind: "noop" });
    expect(planGeometry({ ...base, width: 200, height: 100, fit: "fill" })).toEqual({
      kind: "noop",
    });
  });

  it("contain だけは目標が大きいと背景で埋める（常に目標寸法を返す仕様）", () => {
    // 参照実装 calculate_contain_size:「Contain模式永远返回目标尺寸，因为会用背景填充」。
    // 拡大はしないので 100x50 のまま、200x100 の画布の中央へ置く。
    expect(planGeometry({ ...base, width: 200, height: 100, fit: "contain" })).toEqual({
      kind: "contain",
      scale: 1,
      // 左右に 100、上下に 50 余る（画面はこの slack を見て寄せる位置の要否を決める）。
      slack: { x: 100, y: 50 },
      embed: { x: 50, y: 25, width: 200, height: 100 },
    });
  });

  it("contain で縮小結果がちょうど目標なら余白が無いので resize だけ", () => {
    expect(planGeometry({ ...base, width: 50, height: 25, fit: "contain" })).toEqual({
      kind: "resize",
      scale: 0.5,
      width: 50,
      height: 25,
    });
  });

  it("等倍ちょうどでも何もしない", () => {
    expect(planGeometry({ ...base, width: 100, height: null })).toEqual({ kind: "noop" });
  });
});

describe("規則 2: w と h の両方が在るときだけ fit が効く", () => {
  it("w だけなら等比縮小で、fit も gravity も無視される", () => {
    const a = planGeometry({ ...base, width: 50, height: null, fit: "contain" });
    const b = planGeometry({ ...base, width: 50, height: null, fit: "fill", gravity: "southeast" });
    expect(a).toEqual({ kind: "resize", scale: 0.5, width: 50, height: 25 });
    expect(b).toEqual(a);
  });

  it("h だけでも同じ", () => {
    expect(planGeometry({ ...base, width: null, height: 25 })).toEqual({
      kind: "resize",
      scale: 0.5,
      width: 50,
      height: 25,
    });
  });

  it("どちらも無ければ何もしない", () => {
    expect(planGeometry({ ...base, width: null, height: null })).toEqual({ kind: "noop" });
  });
});

describe("fit ごとの寸法", () => {
  it("cover は目標をちょうど埋め、はみ出た分を切り出す", () => {
    // scale = min(max(40/100, 30/50), 1) = 0.6 → 60x30 → 40x30 を切り出す
    const p = planGeometry({ ...base, width: 40, height: 30 });
    expect(p).toEqual({
      kind: "cover",
      scale: 0.6,
      // 横だけ 20 余る＝上下に寄せても出力は変わらない。
      slack: { x: 20, y: 0 },
      crop: { left: 10, top: 0, width: 40, height: 30 },
    });
  });

  it("contain は縦横比を保って収め、余白を背景で埋める", () => {
    // scale = min(min(40/100, 30/50), 1) = 0.4 → 40x20 を 40x30 の画布の中央へ
    const p = planGeometry({ ...base, width: 40, height: 30, fit: "contain" });
    expect(p).toEqual({
      kind: "contain",
      scale: 0.4,
      // 縦だけ 10 余る＝左右に寄せても出力は変わらない。
      slack: { x: 0, y: 10 },
      embed: { x: 0, y: 5, width: 40, height: 30 },
    });
  });

  it("fill は非等比に引き伸ばす", () => {
    const p = planGeometry({ ...base, width: 50, height: 40, fit: "fill" });
    expect(p).toEqual({ kind: "fill", hscale: 0.5, vscale: 0.8, width: 50, height: 40 });
  });
});

describe("gravity 9 方向", () => {
  // 100x50 を 40x30 に cover → 中間 60x30、余り dx=20 / dy=0
  const coverLeft = (g: ConvertGravity) => {
    const p = planGeometry({ ...base, width: 40, height: 30, gravity: g });
    if (p.kind !== "cover") throw new Error("cover のはず");
    return [p.crop.left, p.crop.top];
  };

  it("cover の切り出し位置", () => {
    expect(coverLeft("center")).toEqual([10, 0]);
    expect(coverLeft("west")).toEqual([0, 0]);
    expect(coverLeft("east")).toEqual([20, 0]);
    expect(coverLeft("north")).toEqual([10, 0]);
    expect(coverLeft("south")).toEqual([10, 0]);
    expect(coverLeft("northwest")).toEqual([0, 0]);
    expect(coverLeft("northeast")).toEqual([20, 0]);
    expect(coverLeft("southwest")).toEqual([0, 0]);
    expect(coverLeft("southeast")).toEqual([20, 0]);
  });

  // 100x50 を 40x30 に contain → 中間 40x20、余白 dx=0 / dy=10
  const containAt = (g: ConvertGravity) => {
    const p = planGeometry({ ...base, width: 40, height: 30, fit: "contain", gravity: g });
    if (p.kind !== "contain") throw new Error("contain のはず");
    return [p.embed.x, p.embed.y];
  };

  it("contain の配置位置", () => {
    expect(containAt("center")).toEqual([0, 5]);
    expect(containAt("north")).toEqual([0, 0]);
    expect(containAt("south")).toEqual([0, 10]);
    expect(containAt("west")).toEqual([0, 5]);
    expect(containAt("east")).toEqual([0, 5]);
    expect(containAt("northwest")).toEqual([0, 0]);
    expect(containAt("northeast")).toEqual([0, 0]);
    expect(containAt("southwest")).toEqual([0, 10]);
    expect(containAt("southeast")).toEqual([0, 10]);
  });

  it("切り出し矩形は中間画像からはみ出さない", () => {
    const gravities: ConvertGravity[] = [
      "center",
      "north",
      "south",
      "east",
      "west",
      "northeast",
      "northwest",
      "southeast",
      "southwest",
    ];
    // 端数の出る寸法で総当たり（丸めで 1px はみ出す事故を捕まえる）。
    for (const srcW of [100, 101, 333]) {
      for (const srcH of [50, 51, 177]) {
        for (const [w, h] of [
          [40, 30],
          [33, 33],
          [7, 99],
        ]) {
          for (const gravity of gravities) {
            const p = planGeometry({ srcW, srcH, width: w, height: h, fit: "cover", gravity });
            if (p.kind !== "cover") continue;
            const midW = Math.round(srcW * p.scale);
            const midH = Math.round(srcH * p.scale);
            expect(p.crop.left).toBeGreaterThanOrEqual(0);
            expect(p.crop.top).toBeGreaterThanOrEqual(0);
            expect(p.crop.left + p.crop.width).toBeLessThanOrEqual(midW);
            expect(p.crop.top + p.crop.height).toBeLessThanOrEqual(midH);
          }
        }
      }
    }
  });
});

describe("規則 3: bg の既定は出力形式で変わる", () => {
  it("透過を保てる形式は transparent", () => {
    for (const f of ["png", "webp", "tiff"])
      expect(effectiveBackground(null, f)).toBe("transparent");
  });

  it("それ以外は白", () => {
    for (const f of ["jpg", "gif", "avif", "jxl", "ppm"])
      expect(effectiveBackground(null, f)).toBe("ffffff");
  });

  it("明示指定が既定に勝つ", () => {
    expect(effectiveBackground("ff0000", "png")).toBe("ff0000");
    expect(effectiveBackground("average", "jpg")).toBe("average");
  });
});

describe("形式名と品質", () => {
  it("別名を正規化する（scan.ts とは逆向き）", () => {
    expect(normalizeOutFormat("jpeg")).toBe("jpg");
    expect(normalizeOutFormat("JPEG")).toBe("jpg");
    expect(normalizeOutFormat(".tif")).toBe("tiff");
    expect(normalizeOutFormat("heif")).toBe("heic");
    expect(normalizeOutFormat("png")).toBe("png");
  });

  it("q は 1..100 に丸める", () => {
    expect(clampQuality(0)).toBe(1);
    expect(clampQuality(-5)).toBe(1);
    expect(clampQuality(101)).toBe(100);
    expect(clampQuality(80)).toBe(80);
    expect(clampQuality(Number.NaN)).toBe(80);
  });

  it("Q を受け付けない形式には渡さない（渡すと libvips が失敗する）", () => {
    expect(saveSpec("jpg", 80)!.options).toMatchObject({ Q: 80 });
    expect(saveSpec("jpeg", 80)!.suffix).toBe(".jpg");
    expect(saveSpec("avif", 200)!.options).toMatchObject({ Q: 100, compression: "av1" });
    expect(saveSpec("gif", 80)!.options).not.toHaveProperty("Q");
    expect(saveSpec("png", 80)!.options).not.toHaveProperty("Q");
    expect(saveSpec("ppm", 80)!.options).toEqual({});
  });

  it("TIFF だけ保存前に sRGB へ寄せる", () => {
    expect(saveSpec("tiff", 80)!.needsSrgb).toBe(true);
    for (const f of ["jpg", "png", "webp", "gif", "avif", "jxl"])
      expect(saveSpec(f, 80)!.needsSrgb, f).toBe(false);
  });

  it("**書けない形式には null を返す**（ここが「何を書けるか」の正本）", () => {
    // 以前は `.heic` / `.svg` の保存指定を作って返していたので、選択肢にも検証にも
    // 「書ける」ことになり、失敗が wasm の例外としてしか現れなかった。
    for (const f of ["heic", "heif", "svg", "bmp", "pdf", "なにこれ"]) {
      expect(saveSpec(f, 80), f).toBeNull();
    }
  });

  it("JPEG の色度間引きを止める設定を落とさない", () => {
    // subsample_mode を落とすと見て分かる画質差が出る（参照実装が明示している）。
    expect(saveSpec("jpg", 80)!.options).toMatchObject({
      optimize_coding: true,
      subsample_mode: "off",
    });
  });
});

describe("背景ベクタのバンド数合わせ", () => {
  // libvips の embed は画像と同じ本数を要求し、足りないと例外を投げる。
  // グレースケール(1band) / グレー+アルファ(2band) を落とすと、その画像で必ず落ちる。
  const red = (i: number) => [255, 0, 0][i]!;

  it("hex 背景は bands ごとに本数を合わせる", () => {
    expect(backgroundVector("ff0000", 4, red)).toEqual([255, 0, 0, 255]);
    expect(backgroundVector("ff0000", 3, red)).toEqual([255, 0, 0]);
    // グレーは Rec.601 で畳む（参照実装と同じ係数）。
    expect(backgroundVector("ff0000", 2, red)).toEqual([255 * 0.299, 255]);
    expect(backgroundVector("ff0000", 1, red)).toEqual([255 * 0.299]);
  });

  it("transparent も bands ごとに変わる（alpha を足せない形は白へ退避）", () => {
    expect(backgroundVector("transparent", 4, red)).toEqual([0, 0, 0, 0]);
    expect(backgroundVector("transparent", 2, red)).toEqual([255, 0]);
    expect(backgroundVector("transparent", 1, red)).toEqual([255]);
    expect(backgroundVector("transparent", 3, red)).toEqual([255, 255, 255]);
  });
});

describe("hex 背景", () => {
  it("6 桁だけ受け付ける（# は剥がす）", () => {
    expect(parseHexRgb("ff8000")).toEqual([255, 128, 0]);
    expect(parseHexRgb("#FF8000")).toEqual([255, 128, 0]);
  });

  it("3 桁の短縮形と不正値は弾く", () => {
    expect(parseHexRgb("fff")).toBeNull();
    expect(parseHexRgb("transparent")).toBeNull();
    expect(parseHexRgb("gggggg")).toBeNull();
    expect(parseHexRgb("")).toBeNull();
  });
});

describe("出力ファイル名", () => {
  it("拡張子を出力形式へ差し替える", () => {
    expect(outPathFor("a/b/photo.jpg", "webp")).toBe("a/b/photo.webp");
    expect(outPathFor("photo.JPEG", "jpeg")).toBe("photo.jpg");
    expect(outPathFor("photo.heic", "avif")).toBe("photo.avif");
  });

  it("形式を変えないなら元の名前のまま", () => {
    expect(outPathFor("a/b/photo.jpg", null)).toBe("a/b/photo.jpg");
  });

  it("拡張子が無い / ディレクトリ名にドットがある場合を壊さない", () => {
    expect(outPathFor("a/b/noext", "png")).toBe("a/b/noext.png");
    expect(outPathFor("a.dir/photo", "png")).toBe("a.dir/photo.png");
    expect(outPathFor("a.dir/photo.jpg", "png")).toBe("a.dir/photo.png");
  });
});

describe("出力名の衝突（同じ実行の中で自分同士がぶつかる）", () => {
  it("形式を変えると別拡張子の同名が衝突することを、始める前に見つける", () => {
    const c = findOutputCollisions([{ path: "a/x.jpg" }, { path: "a/x.png" }], "webp");
    expect(c).toEqual([{ dst: "a/x.webp", srcs: ["a/x.jpg", "a/x.png"] }]);
  });

  it("形式を変えなければ衝突しない", () => {
    expect(findOutputCollisions([{ path: "a/x.jpg" }, { path: "a/x.png" }], null)).toEqual([]);
  });

  it("ディレクトリが違えば衝突しない", () => {
    expect(findOutputCollisions([{ path: "a/x.jpg" }, { path: "b/x.png" }], "webp")).toEqual([]);
  });

  it("結果は決定的（dst 昇順・srcs 昇順）", () => {
    const c = findOutputCollisions(
      [{ path: "z.png" }, { path: "a.gif" }, { path: "z.jpg" }, { path: "a.bmp" }],
      "webp",
    );
    expect(c.map((x) => x.dst)).toEqual(["a.webp", "z.webp"]);
    expect(c[0].srcs).toEqual(["a.bmp", "a.gif"]);
  });
});

describe("ドロップした同名ファイルの取りこぼし防止", () => {
  it("同名は連番になり、1 件も消えない", () => {
    const used = new Set<string>();
    const keys = ["IMG_1.jpg", "IMG_1.jpg", "IMG_1.jpg"].map((n) => {
      const k = uniquePath(n, used);
      used.add(k);
      return k;
    });
    expect(keys).toEqual(["IMG_1.jpg", "IMG_1 (2).jpg", "IMG_1 (3).jpg"]);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("拡張子の切り出し", () => {
  it("ディレクトリ名のドットに騙されない", () => {
    expect(extOf("a.dir/photo")).toBe("");
    expect(extOf("a.dir/photo.JPG")).toBe("jpg");
    expect(extOf("noext")).toBe("");
  });

  it("scan と convert で対象集合が違う（jxl は convert だけ）", () => {
    // scan は CLI と結果一致の契約があるので CLI の既定 ext から広げない（SPEC §1 の parity）。
    expect(isScannableImage("a.jxl")).toBe(false);
    expect(isConvertibleImage("a.jxl")).toBe(true);
    expect(isScannableImage("a.png")).toBe(true);
    expect(isConvertibleImage("a.png")).toBe(true);
  });
});

describe("素通し（SPEC §5.4 規則 4）", () => {
  const base = { width: null, height: null, format: null };

  it("寸法も形式も指定していなければ素通し", () => {
    expect(isPassThrough(base, "png")).toBe(true);
  });

  it("出力形式が入力と同じ（別名違いを含む）なら素通し", () => {
    expect(isPassThrough({ ...base, format: "jpg" }, "jpeg")).toBe(true);
    expect(isPassThrough({ ...base, format: "tiff" }, "tif")).toBe(true);
  });

  it("寸法か形式が変われば素通しではない", () => {
    expect(isPassThrough({ ...base, width: 100 }, "png")).toBe(false);
    expect(isPassThrough({ ...base, format: "webp" }, "png")).toBe(false);
  });

  it("読めるが書けない HEIC も、変換不要なら素通りできる", () => {
    expect(isPassThrough(base, "heic")).toBe(true);
  });
});

describe("背景の既定は出力形式ごとに解決する", () => {
  it("透過を保てる形式は透明、それ以外は白", () => {
    expect(effectiveBackground(null, "png")).toBe("transparent");
    expect(effectiveBackground(null, "tif")).toBe("transparent"); // 別名も正規化して判定
    expect(effectiveBackground(null, "jpg")).toBe("ffffff");
  });

  it("明示指定が既定に勝つ", () => {
    expect(effectiveBackground("average", "png")).toBe("average");
  });
});

describe("フォーム入力の検証（SPEC §5.4 は w/h を u32 とする）", () => {
  const form = { ...DEFAULT_FORM, format: "webp" };
  const err = (f: Partial<typeof form>): string | null => {
    const r = resolveOptions({ ...form, ...f });
    return "error" in r ? r.error : null;
  };

  it("小数は弾く（丸めてから見ると 0.4 が 0 になって『指定したのに何も起きない』になる）", () => {
    expect(err({ width: "0.4" })).toMatch(/整数/);
    expect(err({ height: "10.5" })).toMatch(/整数/);
  });

  it("0 と負数と巨大値を弾く", () => {
    expect(err({ width: "0" })).toMatch(/整数/);
    expect(err({ width: "-5" })).toMatch(/整数/);
    expect(err({ width: "1e12" })).toMatch(/整数/);
  });

  it("空欄は「指定なし」として通る", () => {
    expect(err({ width: "", height: "" })).toBeNull();
  });

  it("正の整数は通る", () => {
    const r = resolveOptions({ ...form, width: "300", height: "200" });
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.options).toMatchObject({ width: 300, height: 200 });
  });

  it("背景は生値のまま渡る（既定の解決は出力形式が確定する側でやる）", () => {
    const r = resolveOptions({ ...form, background: "" });
    if (!("error" in r)) expect(r.options.background).toBeNull();
    const r2 = resolveOptions({ ...form, background: "#FF0000" });
    if (!("error" in r2)) expect(r2.options.background).toBe("#ff0000");
  });

  it("3 桁の hex は、背景が実際に使われるときだけ弾く", () => {
    // 背景は「収める」の余白にしか使われない。そこでは打ち間違いを実行前に止める。
    expect(err({ background: "fff", fit: "contain", width: "100", height: "100" })).toMatch(
      /16 進数/,
    );
    // 使われない設定（切り抜き）では、見えない欄の打ち間違いで実行を止めない。
    expect(err({ background: "fff", fit: "cover", width: "100", height: "100" })).toBeNull();
    expect(err({ background: "fff", fit: "contain" })).toBeNull();
  });
});

describe("画質だけの再圧縮（forceReencode）", () => {
  const base = { width: null, height: null, format: null };

  it("画質を明示したら素通ししない（同じ形式のまま圧縮し直せる）", () => {
    expect(isPassThrough({ ...base, forceReencode: true }, "jpg")).toBe(false);
  });

  it("触っていなければ従来どおり素通し", () => {
    expect(isPassThrough({ ...base, forceReencode: false }, "jpg")).toBe(true);
  });

  it("画質を触っていれば「指定がありません」で断られない", () => {
    const r = resolveOptions({ ...DEFAULT_FORM, qualityTouched: true, quality: 50 });
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.options.forceReencode).toBe(true);
  });
});

describe("次に開いたときも残す設定", () => {
  it("寸法と上書きは残さない（寸法は画像に付随・上書きは安全側へ戻す）", () => {
    const keys = Object.keys(rememberedForm(DEFAULT_FORM)).sort();
    expect(keys).toEqual(
      ["background", "fit", "format", "gravity", "quality", "qualityTouched"].sort(),
    );
  });

  it("画質は qualityTouched と対で残す（片方だけだと黙って無視される状態になる）", () => {
    const kept = rememberedForm({ ...DEFAULT_FORM, quality: 60, qualityTouched: true });
    expect(kept.quality).toBe(60);
    expect(kept.qualityTouched).toBe(true);
  });

  it("保存済みの値は型と取り得る値まで検証する", () => {
    expect(sanitizeStoredForm({ fit: "contain", gravity: "north" })).toEqual({
      fit: "contain",
      gravity: "north",
    });
    // 知らない値・型違い・未知の鍵は通さない（手で書き換えられていても画面を壊さない）。
    expect(sanitizeStoredForm({ fit: "banana", gravity: 3, format: "heic" })).toEqual({});
    expect(sanitizeStoredForm({ overwrite: true, width: "9999" })).toEqual({});
    expect(sanitizeStoredForm(null)).toEqual({});
    expect(sanitizeStoredForm("{}")).toEqual({});
  });

  it("画質は範囲に丸める", () => {
    const q = (quality: unknown) => sanitizeStoredForm({ quality, qualityTouched: true }).quality;
    expect(q(999)).toBe(100);
    expect(q(-5)).toBe(1);
    expect(q(Number.NaN)).toBe(80);
  });

  it("画質と「指定した」は対で戻す（片方だけなら両方捨てる）", () => {
    // 片方だけ戻すと「20 と表示されているのに効かない」「既定値で黙って再符号化する」になる。
    expect(sanitizeStoredForm({ quality: 20 })).toEqual({});
    expect(sanitizeStoredForm({ qualityTouched: true })).toEqual({});
    expect(sanitizeStoredForm({ quality: 20, qualityTouched: true })).toEqual({
      quality: 20,
      qualityTouched: true,
    });
  });

  it("書けない形式は保存値からも弾く", () => {
    expect(sanitizeStoredForm({ format: "" }).format).toBe("");
    expect(sanitizeStoredForm({ format: "webp" }).format).toBe("webp");
    expect(sanitizeStoredForm({ format: "svg" }).format).toBeUndefined();
  });
});

describe("読めるが書けない形式は実行前に止める", () => {
  const form = { ...DEFAULT_FORM, width: "100", height: "100" };
  const src = (path: string) => ({ path, bytes: () => Promise.resolve(new ArrayBuffer(0)) });

  it("heic を変換しようとして出力形式が未指定なら理由を返す", () => {
    useConvertStore.getState().setSources([src("a.heic")]);
    useConvertStore.getState().setForm(form);
    expect(useConvertStore.getState().validate()).toMatch(/書き出せません/);
  });

  it("出力形式を指定すれば通る", () => {
    useConvertStore.getState().setSources([src("a.heic")]);
    useConvertStore.getState().setForm({ ...form, format: "jpg" });
    expect(useConvertStore.getState().validate()).toBeNull();
  });

  it("素通しになる分は止めない（元のバイト列をそのまま出すだけなので）", () => {
    useConvertStore.getState().setSources([src("a.heic")]);
    // 寸法も形式も指定しない＝何も変えない ⇒ 素通し。ただし「やることが無い」は別の理由で止まる。
    useConvertStore.getState().setForm({ ...DEFAULT_FORM, width: "", height: "" });
    expect(useConvertStore.getState().validate()).toMatch(/変換する指定がありません/);
  });
});

describe("プレビューは原寸が届いてから作る", () => {
  const src = (path: string) => ({ path, bytes: () => Promise.resolve(new ArrayBuffer(0)) });
  const info = { width: 1024, height: 1024, bytes: 1_700_000 };

  it("原寸が届くと鍵が変わる（＝先に始めた分は捨てるために符号化したことになる）", () => {
    useConvertStore.getState().setSources([src("a.png")]);
    useConvertStore.getState().setForm({ ...DEFAULT_FORM, format: "avif" });
    const unknown = previewKey(useConvertStore.getState());
    useConvertStore.setState({ sourceInfo: new Map([["a.png", info]]) });
    expect(previewKey(useConvertStore.getState())).not.toBe(unknown);
  });

  it("原寸を知らないうちは走らせない（走らせると二度手間の上に、大きすぎる画像を止められない）", async () => {
    useConvertStore.getState().setSources([src("a.png")]);
    useConvertStore.getState().setForm({ ...DEFAULT_FORM, format: "avif" });
    useConvertStore.setState({ loadSourceInfo: () => Promise.resolve() });
    await useConvertStore.getState().renderPreview();
    expect(useConvertStore.getState().preview).toBeNull();
    expect(useConvertStore.getState().previewRendering).toBe(false);
    // **答えを書かずに戻る**＝まだ試していない。保存ボタンはここでは押せない。
    expect(previewSettled(useConvertStore.getState())).toBe(false);
  });

  it("原寸が無いときは取りに行かせる（中断で 1 枚だけ落ちていても詰まらない）", async () => {
    // 中断はサムネの失敗を記録しないので、催促しないと鍵が二度と変わらず、
    // プレビューも保存ボタンも永久に止まる（「もっと見る」が出ない枚数だと戻す手も無い）。
    const asked: number[] = [];
    useConvertStore.getState().setSources([src("a.png"), src("b.png"), src("c.png")]);
    useConvertStore.getState().setPreviewPath("c.png");
    useConvertStore.setState({
      loadSourceInfo: (upTo) => {
        asked.push(upTo);
        return Promise.resolve();
      },
    });
    await useConvertStore.getState().renderPreview();
    // 代表は 3 枚目なので、そこまでを要求する。
    expect(asked).toEqual([3]);
  });
});
