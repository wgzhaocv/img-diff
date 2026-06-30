import { expect, test } from "vite-plus/test";
import { HASH, HASH_BITS, SCHEMA_VERSION } from "../src/index.ts";

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
