// `persist` の保存先に掛けた囲い（`dedupedStorage`）の回帰試験。
// ここが守るのは 2 つ: **投げても止まらない** と **同じ物を二度書かない**。
// どちらも失効の作法を間違えると静かに壊れる（設定が黙って残らなくなる）。

import { describe, expect, it } from "vite-plus/test";
import { dedupedStorage, type SyncStorage } from "@/lib/persistStorage";

/** 呼ばれた回数を数える偽の保存先。`fail` を立てると投げる。 */
function fake(): SyncStorage & { writes: [string, string][]; removes: string[]; fail: boolean } {
  const map = new Map<string, string>();
  const o = {
    writes: [] as [string, string][],
    removes: [] as string[],
    fail: false,
    getItem: (k: string) => {
      if (o.fail) throw new Error("読めない");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (o.fail) throw new Error("書けない");
      o.writes.push([k, v]);
      map.set(k, v);
    },
    removeItem: (k: string) => {
      if (o.fail) throw new Error("消せない");
      o.removes.push(k);
      map.delete(k);
    },
  };
  return o;
}

describe("dedupedStorage", () => {
  it("同じ値を続けて書いても 1 回しか届かない", () => {
    const raw = fake();
    const s = dedupedStorage(raw);
    s.setItem("k", "a");
    s.setItem("k", "a");
    s.setItem("k", "a");
    expect(raw.writes).toEqual([["k", "a"]]);
  });

  it("値が変われば書く", () => {
    const raw = fake();
    const s = dedupedStorage(raw);
    s.setItem("k", "a");
    s.setItem("k", "b");
    s.setItem("k", "a");
    expect(raw.writes.map(([, v]) => v)).toEqual(["a", "b", "a"]);
  });

  it("鍵ごとに覚える", () => {
    const raw = fake();
    const s = dedupedStorage(raw);
    s.setItem("k1", "a");
    s.setItem("k2", "a");
    expect(raw.writes).toEqual([
      ["k1", "a"],
      ["k2", "a"],
    ]);
  });

  it("**書けなかったら覚えない**（次に同じ値を書いたら、もう一度試す）", () => {
    // ここを間違えると、一度 Quota で失敗しただけで**設定が二度と保存されなくなる**。
    const raw = fake();
    const s = dedupedStorage(raw);
    raw.fail = true;
    expect(() => s.setItem("k", "a")).not.toThrow();
    raw.fail = false;
    s.setItem("k", "a");
    expect(raw.writes).toEqual([["k", "a"]]);
  });

  it("消したら忘れる（同じ値をまた書ける）", () => {
    const raw = fake();
    const s = dedupedStorage(raw);
    s.setItem("k", "a");
    s.removeItem("k");
    s.setItem("k", "a");
    expect(raw.writes).toEqual([
      ["k", "a"],
      ["k", "a"],
    ]);
    expect(raw.removes).toEqual(["k"]);
  });

  it("読み書き消しのどれが投げても外へ漏らさない", () => {
    const raw = fake();
    const s = dedupedStorage(raw);
    raw.fail = true;
    expect(s.getItem("k")).toBeNull(); // 読めない環境は「まだ何も無い」と同じ。
    expect(() => s.setItem("k", "a")).not.toThrow();
    expect(() => s.removeItem("k")).not.toThrow();
  });

  it("読める値はそのまま通す", () => {
    const raw = fake();
    const s = dedupedStorage(raw);
    s.setItem("k", "a");
    expect(s.getItem("k")).toBe("a");
    expect(s.getItem("none")).toBeNull();
  });
});
