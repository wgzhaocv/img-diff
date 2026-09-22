import { expect, test } from "vite-plus/test";
import { HASH, HASH_BITS, SCANNABLE_EXTS, SCHEMA_VERSION } from "../src/index.ts";

test("ハッシュは 64 ビット", () => {
  expect(HASH_BITS).toBe(64);
  expect(HASH.WIDTH * HASH.HEIGHT).toBe(HASH_BITS);
});

test("グレースケール係数の和は 1 に近い", () => {
  const sum = HASH.GRAY.r + HASH.GRAY.g + HASH.GRAY.b;
  expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
});

test("スキーマバージョンは正の整数", () => {
  expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  expect(SCHEMA_VERSION).toBeGreaterThan(0);
});

// scan の集合は web/CLI の両方が同じでなければならない（SPEC §1 の parity）。
// CLI 側の同値の試験は crates/cli/src/index.rs の default_ext_matches_schema。
test("scan の拡張子集合は tif/tiff を両方持ち、svg を持たない", () => {
  expect(SCANNABLE_EXTS).toContain("tif");
  expect(SCANNABLE_EXTS).toContain("tiff");
  expect(SCANNABLE_EXTS).not.toContain("svg");
  expect(new Set(SCANNABLE_EXTS).size).toBe(SCANNABLE_EXTS.length);
  expect(SCANNABLE_EXTS.every((e) => e === e.toLowerCase() && !e.startsWith("."))).toBe(true);
});
