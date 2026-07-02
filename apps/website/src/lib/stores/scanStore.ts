import { create } from "zustand";
import { toast } from "sonner";
import { runScan, scanFolder, type ScanProgress, type ScanResult } from "@/lib/scan";
import { clusterGroup, type DupGroup, type Strictness } from "@/lib/core";
import { defaultPoolSize, HashPool } from "@/lib/workerPool";

// scan 画面の状態ストア（zustand）。コンポーネント外に持つのでルート切替でアンマウントされても
// スキャン結果・厳密度・グループ・進捗が保持される。ワーカープールもここで使い回す。

const POOL_SIZE = defaultPoolSize();
let pool: HashPool | null = null;
const getPool = (): HashPool => (pool ??= new HashPool(POOL_SIZE));
let running = false; // スキャンの二重起動防止。
let clusterToken = 0; // クラスタリングの競合（古い結果の上書き）を防ぐ単調トークン。

type Status = "idle" | "scanning" | "done";

type ScanState = {
  status: Status;
  progress: ScanProgress;
  result: ScanResult | null;
  elapsedMs: number;
  strictness: Strictness;
  /** perceptual のしきい値（確定値。入力の debounce は画面側）。 */
  threshold: number;
  groups: DupGroup[];
  setStrictness: (s: Strictness) => void;
  setThreshold: (t: number) => void;
  runFiles: (files: File[]) => Promise<void>;
  runFolder: (handle: FileSystemDirectoryHandle) => Promise<void>;
};

export const useScanStore = create<ScanState>((set, get) => {
  // 厳密度/しきい値/結果からグループを再計算（切替は再スキャン不要・SPEC §2）。
  // 競合トークンで、古い非同期結果が新しい結果を上書きしないようにする。
  async function recluster(): Promise<void> {
    const { result, strictness, threshold } = get();
    if (!result) {
      set({ groups: [] });
      return;
    }
    const token = ++clusterToken;
    try {
      const groups = await clusterGroup(
        result.images,
        strictness,
        strictness === "perceptual" ? threshold : undefined,
      );
      if (token === clusterToken) set({ groups });
    } catch (e) {
      if (token === clusterToken)
        toast.error("グループ化に失敗しました", { description: String(e) });
    }
  }

  // スキャン実行の共通ラッパ（二重起動防止・状態遷移・空結果/失敗の通知・計測）。
  async function runIndex(doScan: () => Promise<ScanResult>): Promise<void> {
    if (running) return;
    running = true;
    set({
      status: "scanning",
      result: null,
      groups: [],
      progress: { phase: "hash", processed: 0, total: 0 },
    });
    const start = performance.now();
    try {
      const result = await doScan();
      if (result.images.length === 0) {
        toast.info("対象の画像が見つかりませんでした", {
          description: "jpg / png / webp / heic / avif / svg などを含むフォルダを選んでください。",
        });
        set({ status: "idle" });
        return;
      }
      set({ result, elapsedMs: Math.round(performance.now() - start), status: "done" });
      void recluster();
    } catch (e) {
      toast.error("スキャンに失敗しました", {
        description: e instanceof Error ? e.message : String(e),
      });
      set({ status: "idle" });
    } finally {
      running = false;
    }
  }

  const onProgress = (progress: ScanProgress) => set({ progress });

  return {
    status: "idle",
    progress: { phase: "hash", processed: 0, total: 0 },
    result: null,
    elapsedMs: 0,
    strictness: "exact",
    threshold: 10,
    groups: [],
    setStrictness: (strictness) => {
      set({ strictness });
      void recluster();
    },
    setThreshold: (threshold) => {
      set({ threshold });
      void recluster();
    },
    runFiles: (files) => runIndex(() => runScan(files, getPool(), POOL_SIZE, onProgress)),
    runFolder: (handle) => runIndex(() => scanFolder(handle, getPool(), POOL_SIZE, onProgress)),
  };
});
