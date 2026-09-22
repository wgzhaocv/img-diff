import type { StateStorage } from "zustand/middleware";

/**
 * 同期で答える保存先（`localStorage` のような物）。`StateStorage` は Promise も許すが、
 * [`dedupedStorage`] の失効の作法は同期を前提にしているので、**型で同期に縛る**。
 */
export type SyncStorage = {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
};

// zustand `persist` の保存先を包む小道具。ストアを作らずに import できる場所に置く
// （ストアの module を読むと `persist` がその場で localStorage を触るので、node から試験できない）。

/**
 * 保存先を **壊れない・無駄に書かない** 形に包む。
 *
 * 1. **投げても画面を止めない**（これが主目的）。読み書きとも try で囲む（Quota 超過・
 *    SecurityError・サンドボックス内の iframe）。zustand は `set` のたびに保存するので、
 *    ここで投げると「設定が残らない」では済まず、**その操作ごと巻き添え**になる。
 *    読みも囲む —— 保存が無効な環境では `localStorage` の**参照そのもの**が投げる。
 * 2. **同じ物を二度書かない。** `partialize` は保存する**中身**を絞るが、書く**契機**は絞らない
 *    （寸法だけの打鍵でも、プレビューの開始 / 結果 / 終了でも呼ばれる）。
 *    ただし**速度の話ではない** —— `JSON.stringify` は `createJSONStorage` の側、つまり
 *    この包みの外で既に走っているので、省けるのは 200 バイト程度の `setItem` だけ。
 *    値打ちは「書かなくてよいときは書かない」という素直さと、保存先を余計に減らさないこと。
 *
 * 失効の作法がこの実装の要点:
 * **書けなかったら「書けた」ことにしない**（覚えてしまうと、次に同じ値を書くときも飛ばして
 * 設定が黙って残らなくなる）/ `removeItem` で忘れる / 鍵ごとに持つ。
 *
 * **前提**: 同じ鍵を書くのはこのタブだけ。別のタブが違う値を書いた場合、こちらは
 * 「自分が最後に書いた値」と同じなら書き直さないので、あちらの値が残る。
 * 保存しているのが設定だけ（どのみち最後に書いた方が勝つ）なので、これは受け入れる。
 *
 * `raw` を引数で受けるのは、node の試験から偽の保存先（投げる物を含む）を渡せるようにするため。
 * **同期の保存先しか受けない**（型で縛る）。Promise を返す保存先を許すと、拒否を `null` に
 * 変換できず、`setItem` が終わる前に「書けた」と覚えてしまう。
 */
export function dedupedStorage(raw: SyncStorage): StateStorage {
  const written = new Map<string, string>();
  return {
    getItem: (name) => {
      try {
        return raw.getItem(name);
      } catch {
        return null; // 読めない環境は「まだ何も保存していない」と同じに見せる。
      }
    },
    setItem: (name, value) => {
      if (written.get(name) === value) return;
      try {
        raw.setItem(name, value);
        written.set(name, value);
      } catch {
        written.delete(name);
      }
    },
    removeItem: (name) => {
      written.delete(name);
      try {
        raw.removeItem(name);
      } catch {
        // 設定が次回に残るだけ。今の操作は続行する。
      }
    },
  };
}

/**
 * ブラウザの `localStorage` を指す生の保存先（囲いは [`dedupedStorage`] が掛ける）。
 *
 * **`localStorage` の参照を各メソッドの中に置く**のが要点。`createJSONStorage(() => localStorage)`
 * のように外で触ると、保存が無効な環境では**そこで**投げ、zustand は persist ごと諦めて警告を出す。
 * 中に置けば参照も `dedupedStorage` の try に入るので、画面は黙って動き続ける。
 */
export const browserLocalStorage: SyncStorage = {
  getItem: (name) => localStorage.getItem(name),
  setItem: (name, value) => localStorage.setItem(name, value),
  removeItem: (name) => localStorage.removeItem(name),
};
