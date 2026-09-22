// scan の編排まわり（vips にも DOM にも依存しない部分）の回帰試験。
//
// ここが守るのは 2 つ:
//   1. **一本が落ちたら、残りが走り続けない**（落ちた後も全件を読み込み続けると、利用者が
//      諦めた後の仕事にファイル 1 件ぶんの読み込みを払い続ける）。
//   2. **中身を確かめられていないフォルダのキャッシュを掃除しない**（読めなかっただけの所を
//      「無くなった」と読むと、次に読めたときに全部作り直しになる）。

import { describe, expect, it } from "vite-plus/test";
import { runBounded, underUnreadable } from "@/lib/scan";
import { walkImages } from "@/lib/fsaccess";

/** マクロタスクを n 回ぶん進める（壁時計に依存しない待ち方）。 */
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * 何も起きなくなるまで進める。**固定の sleep を使わない** ——
 * 落ちた後も残りの runner は回り続けるので、そこを待たずに数えると
 * 直す前のコードでも緑になってしまう（最初に書いた試験がまさにそれだった）。
 */
async function settle(count: () => number): Promise<void> {
  let prev = -1;
  while (prev !== count()) {
    prev = count();
    await ticks(1);
  }
}

describe("runBounded の停止", () => {
  it("最初の失敗より後は新しい項目を取らない", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const started: number[] = [];
    const boom = new Error("最初の 1 件で落ちる");
    await expect(
      runBounded(items, 4, async (n) => {
        started.push(n);
        await ticks(1);
        if (n === 0) throw boom;
      }),
    ).rejects.toBe(boom);

    await settle(() => started.length);

    // 旗を見るのは**次を取る所**なので、同じ回で走り出した 4 本までは始まる。
    // 肝心なのは 100 件を取り切らないこと（直す前はここが 100 に達していた）。
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it("最初に落ちた例外がそのまま出る", async () => {
    const early = new Error("先に落ちる");
    const late = new Error("後で落ちる");
    await expect(
      runBounded([0, 1], 2, async (n) => {
        await ticks(n === 0 ? 1 : 3);
        throw n === 0 ? early : late;
      }),
    ).rejects.toBe(early);
  });

  it("落ちなければ全件を 1 回ずつ、同時は limit 本まで", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const seen: number[] = [];
    let live = 0;
    let peak = 0;
    await runBounded(items, 3, async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      await ticks(1);
      seen.push(n);
      live -= 1;
    });
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("空でも limit が多すぎても止まらない", async () => {
    await expect(runBounded([], 4, async () => {})).resolves.toBeUndefined();
    let n = 0;
    await runBounded([1, 2], 99, async () => {
      n += 1;
    });
    expect(n).toBe(2);
  });
});

// --- walkImages 用の偽ハンドル（FS Access の最小面だけ） ---

type FakeEntry = { kind: "file" } | { kind: "directory"; children: FakeTree; throwAfter?: number };
type FakeTree = Record<string, FakeEntry>;

function fakeDir(children: FakeTree, throwAfter?: number): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    async *entries() {
      let n = 0;
      for (const [name, child] of Object.entries(children)) {
        if (throwAfter != null && n >= throwAfter) throw new Error("列挙できない");
        n += 1;
        yield [
          name,
          child.kind === "file"
            ? ({ kind: "file", name } as unknown as FileSystemFileHandle)
            : fakeDir(child.children, child.throwAfter),
        ];
      }
    },
  } as unknown as FileSystemDirectoryHandle;
}

const isImage = (name: string): boolean => name.endsWith(".jpg");

describe("walkImages が「読めなかったフォルダ」を返す", () => {
  it("全部読めたら空", async () => {
    const root = fakeDir({
      "a.jpg": { kind: "file" },
      sub: { kind: "directory", children: { "b.jpg": { kind: "file" } } },
    });
    const { files, unreadableDirs } = await walkImages(root, isImage);
    expect(files.map((f) => f.path).sort()).toEqual(["a.jpg", "sub/b.jpg"]);
    expect(unreadableDirs.size).toBe(0);
  });

  it("読めない部分木だけを挙げ、読める兄弟は拾い続ける", async () => {
    const root = fakeDir({
      ok: { kind: "directory", children: { "b.jpg": { kind: "file" } } },
      bad: { kind: "directory", children: { "c.jpg": { kind: "file" } }, throwAfter: 0 },
    });
    const { files, unreadableDirs } = await walkImages(root, isImage);
    expect(files.map((f) => f.path)).toEqual(["ok/b.jpg"]);
    expect([...unreadableDirs]).toEqual(["bad"]);
  });

  it("途中まで読めたフォルダは、拾えた分を残したうえで挙げる", async () => {
    const root = fakeDir({
      part: {
        kind: "directory",
        children: { "b.jpg": { kind: "file" }, "c.jpg": { kind: "file" } },
        throwAfter: 1,
      },
    });
    const { files, unreadableDirs } = await walkImages(root, isImage);
    expect(files.map((f) => f.path)).toEqual(["part/b.jpg"]);
    expect([...unreadableDirs]).toEqual(["part"]);
  });

  it("根そのものが読めなければ空文字（＝全部が守られる）", async () => {
    const root = fakeDir({ "a.jpg": { kind: "file" } }, 0);
    const { files, unreadableDirs } = await walkImages(root, isImage);
    expect(files).toEqual([]);
    expect([...unreadableDirs]).toEqual([""]);
  });
});

describe("掃除の対象から外す部分木（underUnreadable）", () => {
  it("読めなかったフォルダの下は守る", () => {
    expect(underUnreadable("a/b/c.jpg", new Set(["a/b"]))).toBe(true);
    // もっと上で失敗していても守る（祖先を根まで辿る）。
    expect(underUnreadable("a/b/c/d.jpg", new Set(["a"]))).toBe(true);
  });

  it("名前が前方一致するだけの兄弟は守らない", () => {
    // フォルダ単位で辿るので、"a/bb" が "a/b" に巻き込まれない。
    expect(underUnreadable("a/bb/c.jpg", new Set(["a/b"]))).toBe(false);
  });

  it("読めた兄弟は守らない", () => {
    expect(underUnreadable("a/x/c.jpg", new Set(["a/b"]))).toBe(false);
  });

  it("根が読めなければ全部守る（掃除そのものをしない）", () => {
    expect(underUnreadable("anything/at/all.jpg", new Set([""]))).toBe(true);
    expect(underUnreadable("top.jpg", new Set([""]))).toBe(true);
  });

  it("全部読めたなら何も守らない —— **フォルダごと消えた物もここで掃除される**", () => {
    // 白名単（読めたフォルダだけを掃除可）にすると、消えたフォルダは当然その集合に入らないので
    // 配下のキャッシュが永久に残る。祖先が全部読めているなら「もう無い」と言い切ってよい。
    expect(underUnreadable("old-dir/a.jpg", new Set())).toBe(false);
    expect(underUnreadable("a/b/c.jpg", new Set())).toBe(false);
  });
});
