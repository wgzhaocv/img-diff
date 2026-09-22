import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vite-plus/test";
import init, { flatten_and_dhash } from "@/wasm/imgdiff_wasm";
import { applyDecode, VIPS_DYNAMIC_LIBRARIES, type Vips } from "@/workers/vips";

// SPEC §1 が要求する「固定画像 + 既知 dHash」の web 側。
// **同じ `tests/golden.json` を CLI 側（`crates/cli/src/pipeline.rs` の `golden_fixtures_match`）も読む**
// ので、両端がずれたらどちらかが落ちる。
//
// **`crates/wasm` の parity（GOLDEN 定数）とは守る範囲が違う。** あちらは合成 RGBA から始まる
// ので、デコーダを 1 つも通らない ⇒ 原生 libvips と wasm-vips がずれても緑のままになる。
// ここは実ファイルから始めるので、手順 1〜3（デコード・autorot・sRGB）まで含めて押さえる。

type GoldenImage = {
  file: string;
  sha256: string;
  width: number;
  height: number;
  dhash: string;
};

const goldenDir = new URL("../../../tests/", import.meta.url);
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("golden.json", goldenDir)), "utf8"),
) as {
  hashAlgo: string;
  images: GoldenImage[];
};

let vips: Vips;

beforeAll(async () => {
  const mod = (await import("wasm-vips")) as unknown as {
    default: (cfg?: Record<string, unknown>) => Promise<Vips>;
  };
  // **本番と同じ動的ライブラリ一覧**（`VIPS_DYNAMIC_LIBRARIES`）で起こす。
  // 以前ここだけ resvg を外していたので、svg まわりの差が試験から一切見えなかった。
  const v = await mod.default({ dynamicLibraries: VIPS_DYNAMIC_LIBRARIES });
  v.concurrency(1);
  vips = v;
  // 本番は `?url` で配られた実ファイルを取りに行くが、node にはその URL が無いので
  // ディスクから読んで渡す（読み込ませる wasm は同じ物）。
  await init({
    module_or_path: readFileSync(
      fileURLToPath(new URL("../src/wasm/imgdiff_wasm_bg.wasm", import.meta.url)),
    ),
  });
}, 60_000);

it("夹具は 1 枚以上あり、手順のバージョンが一致する", () => {
  expect(golden.images.length).toBeGreaterThan(0);
  expect(golden.hashAlgo).toBe("dhash-1");
});

for (const want of golden.images) {
  it(`${want.file}: 寸法と dHash が golden と一致する`, () => {
    const bytes: ArrayBuffer = new Uint8Array(
      readFileSync(fileURLToPath(new URL(`fixtures/${want.file}`, goldenDir))),
    ).buffer;
    // **夹具そのものが入れ替わっていないこと**を先に見る（夹具だけ差し替える / 期待値だけ直す、
    // のどちらでも「緑のまま意味が変わる」ので）。
    expect(createHash("sha256").update(new Uint8Array(bytes)).digest("hex")).toBe(want.sha256);

    const decoded = applyDecode(vips, { kind: "encoded", bytes }, false);
    expect([decoded.width, decoded.height]).toEqual([want.width, want.height]);
    // `flatten_and_dhash` は rgba を in-place で白平坦化する（SPEC §1 手順 4〜8）。
    expect(flatten_and_dhash(decoded.rgba, decoded.width, decoded.height)).toBe(want.dhash);
  });
}
