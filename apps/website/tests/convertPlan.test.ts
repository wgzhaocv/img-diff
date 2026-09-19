// convert の算術（SPEC §5.4）の回帰試験。ここが変換の判定そのものなので、
// 4 つの規則と gravity 9 方向を網羅する。vips には依存しない（純関数のみ）。

import { describe, expect, it } from "vite-plus/test";
import type { ConvertGravity } from "schema";
import {
  clampQuality,
  effectiveBackground,
  isNoopRequest,
  normalizeOutFormat,
  parseHexRgb,
  planGeometry,
  suffixFor,
} from "@/lib/convertPlan";

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
      crop: { left: 10, top: 0, width: 40, height: 30 },
    });
  });

  it("contain は縦横比を保って収め、余白を背景で埋める", () => {
    // scale = min(min(40/100, 30/50), 1) = 0.4 → 40x20 を 40x30 の画布の中央へ
    const p = planGeometry({ ...base, width: 40, height: 30, fit: "contain" });
    expect(p).toEqual({
      kind: "contain",
      scale: 0.4,
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

describe("規則 4: no-op 検出", () => {
  const opts = {
    width: null,
    height: null,
    fit: "cover",
    gravity: "center",
    background: "ffffff",
    format: null,
    quality: 80,
  } as const;

  it("形式も寸法も変えないなら no-op", () => {
    expect(isNoopRequest(opts, "png")).toBe(true);
  });

  it("形式が同じ（別名違い）でも no-op", () => {
    expect(isNoopRequest({ ...opts, format: "jpg" }, "jpeg")).toBe(true);
  });

  it("形式か寸法が変われば no-op ではない", () => {
    expect(isNoopRequest({ ...opts, format: "webp" }, "png")).toBe(false);
    expect(isNoopRequest({ ...opts, width: 10 }, "png")).toBe(false);
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

  it("gif と ppm には Q を付けない（libvips が受け付けない）", () => {
    expect(suffixFor("jpg", 80)).toBe(".jpg[Q=80]");
    expect(suffixFor("jpeg", 80)).toBe(".jpg[Q=80]");
    expect(suffixFor("avif", 200)).toBe(".avif[Q=100]");
    expect(suffixFor("gif", 80)).toBe(".gif");
    expect(suffixFor("ppm", 80)).toBe(".ppm");
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
