import { create } from "zustand";
import { toast } from "sonner";
import { compareFiles, type CompareOutcome, type ComparePhase } from "@/lib/compare";
import { poolRef } from "@/lib/workerPool";
import { errText } from "@/lib/format";

// compare 画面の状態ストア（zustand）。コンポーネント外に持つのでルート切替でアンマウントされても
// 選択ファイル・比較結果が保持される。ワーカープールもここで使い回す（暖まったまま＝再比較が速い）。

// compare は 2 枚だけなのでプールは 2 本で十分（scan の大規模プールとは別インスタンス）。
const POOL_SIZE = 2;
const pool = poolRef(POOL_SIZE); // 破棄後も作り直せる持ち手（workerPool.ts）。
let running = false; // 二重起動防止（描画に無関係なのでストア外に置く）。

type Status = "idle" | "comparing" | "done";

type CompareState = {
  fileA: File | null;
  fileB: File | null;
  outcome: CompareOutcome | null;
  status: Status;
  phase: ComparePhase;
  /** A/B の一方を選ぶ。両方揃ったら即比較。 */
  pick: (which: "a" | "b", file: File) => void;
};

export const useCompareStore = create<CompareState>((set, get) => {
  async function run(a: File, b: File): Promise<void> {
    if (running) return;
    running = true;
    const releaseHold = pool.hold(); // 走行中は畳ませない（画面を離れても最後まで走る）
    set({ status: "comparing", phase: "decode", outcome: null });
    try {
      const outcome = await compareFiles(a, b, pool.get(), (phase) => set({ phase }));
      set({ outcome, status: "done" });
    } catch (e) {
      toast.error("比較に失敗しました", {
        description: errText(e),
      });
      set({ status: "idle" });
    } finally {
      running = false;
      releaseHold();
    }
  }

  return {
    fileA: null,
    fileB: null,
    outcome: null,
    status: "idle",
    phase: "decode",
    pick: (which, file) => {
      const { fileA, fileB } = get();
      const a = which === "a" ? file : fileA;
      const b = which === "b" ? file : fileB;
      set(which === "a" ? { fileA: file } : { fileB: file });
      if (a && b) void run(a, b);
      else set({ status: "idle" });
    },
  };
});
