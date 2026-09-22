import { describe, expect, it } from "vite-plus/test";
import { dedupeInFlight } from "@/lib/inflight";

// 一覧の描画で「同じサムネを同時に何度も引く」を止める道具。DESIGN §3。

/** 外から解決できる Promise（走行中かどうかを試験側が決められるようにする）。 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("走行中の呼び出しをまとめる", () => {
  it("同じ鍵で同時に頼むと 1 回しか走らない", async () => {
    let calls = 0;
    const d = deferred<string>();
    const get = dedupeInFlight(
      (k: string) => k,
      (k: string) => {
        calls++;
        void k;
        return d.promise;
      },
    );
    const a = get("x");
    const b = get("x");
    expect(calls).toBe(1);
    d.resolve("答え");
    expect(await Promise.all([a, b])).toEqual(["答え", "答え"]);
  });

  it("鍵が違えば別々に走る", () => {
    let calls = 0;
    const get = dedupeInFlight(
      (k: string) => k,
      () => {
        calls++;
        return new Promise<void>(() => undefined);
      },
    );
    void get("x");
    void get("y");
    expect(calls).toBe(2);
  });

  it("終わったら忘れる（キャッシュではない）", async () => {
    let calls = 0;
    const get = dedupeInFlight(
      (k: string) => k,
      () => {
        calls++;
        return Promise.resolve(calls);
      },
    );
    expect(await get("x")).toBe(1);
    expect(await get("x")).toBe(2); // 走り終えた後は改めて引き直す
  });

  it("失敗も共有し、その後は引き直せる（失敗を覚え込まない）", async () => {
    let calls = 0;
    const d = deferred<number>();
    const get = dedupeInFlight(
      (k: string) => k,
      () => {
        calls++;
        return calls === 1 ? d.promise : Promise.resolve(42);
      },
    );
    const a = get("x");
    const b = get("x");
    d.reject(new Error("駄目"));
    await expect(a).rejects.toThrow(/駄目/);
    await expect(b).rejects.toThrow(/駄目/);
    expect(await get("x")).toBe(42);
  });
});
