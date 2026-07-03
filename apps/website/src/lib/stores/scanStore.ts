import { create } from "zustand";
import { toast } from "sonner";
import { runScan, scanFolder, type ScanProgress, type ScanResult } from "@/lib/scan";
import { clusterGroup, type DupGroup, type Strictness } from "@/lib/core";
import { applyDeletions, planDeletions, type CleanResult } from "@/lib/clean";
import { requestWritePermission } from "@/lib/fsaccess";
import { formatBytes } from "@/lib/format";
import { defaultPoolSize, HashPool } from "@/lib/workerPool";

// scan 画面の状態ストア（zustand）。コンポーネント外に持つのでルート切替でアンマウントされても
// スキャン結果・厳密度・グループ・進捗が保持される。ワーカープールもここで使い回す。

const POOL_SIZE = defaultPoolSize();
let pool: HashPool | null = null;
const getPool = (): HashPool => (pool ??= new HashPool(POOL_SIZE));
let running = false; // スキャンの二重起動防止。
let deleting = false; // 実削除の二重起動防止。
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
  /** FS Access 経路の root ハンドル（実削除に必須）。File[] 経路では null＝削除不可。 */
  rootHandle: FileSystemDirectoryHandle | null;
  setStrictness: (s: Strictness) => void;
  setThreshold: (t: number) => void;
  runFiles: (files: File[]) => Promise<void>;
  runFolder: (handle: FileSystemDirectoryHandle) => Promise<void>;
  /** autoDeletable グループの keeper 以外を恒久削除する（SPEC §5.1・破壊的）。結果を返す。 */
  deleteDuplicates: () => Promise<CleanResult | null>;
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

  // 重複の実削除（SPEC §5.1・破壊的・恒久）。権限要求 → applyDeletions → store/IDB reconcile → 再クラスタ。
  // FS Access 経路（rootHandle あり）でのみ動く。呼び出し（AlertDialog の確認 click）内で権限を昇格する。
  async function deleteDuplicates(): Promise<CleanResult | null> {
    if (deleting) return null;
    const { rootHandle, result, groups } = get();
    if (!rootHandle || !result?.rootId) return null; // File[] 経路は削除不可（UI 側でも無効化）。
    const planned = planDeletions(groups, result.images);
    if (planned.length === 0) return null;

    deleting = true;
    try {
      // 削除の click 内で readwrite へ昇格（scan は read のみ。DESIGN §6.3）。
      const granted = await requestWritePermission(rootHandle);
      if (!granted) {
        toast.error("削除にはフォルダへの書き込み許可が必要です");
        return null;
      }

      const res = await applyDeletions(rootHandle, result.rootId, planned);

      // store を reconcile（削除できたパスを images/fileByPath/thumbByPath から除く）→ 再クラスタ。
      // 削除中に新スキャンで result が差し替わっていたら、捕捉済みの古い result は書き戻さない
      // （実ファイルとキャッシュは既に更新済みで、新しい result が実状を反映する）。recluster の
      // clusterToken と同型の世代ガード。
      const deleted = new Set(res.deletedPaths);
      if (deleted.size > 0 && get().result === result) {
        const fileByPath = new Map(result.fileByPath);
        const thumbByPath = result.thumbByPath ? new Map(result.thumbByPath) : undefined;
        for (const p of deleted) {
          fileByPath.delete(p);
          thumbByPath?.delete(p);
        }
        set({
          result: {
            ...result,
            images: result.images.filter((r) => !deleted.has(r.path)),
            fileByPath,
            thumbByPath,
          },
        });
        await recluster();
      }

      const ok = res.deletedPaths.length;
      const failed = res.outcomes.length - ok;
      if (failed === 0) {
        toast.success(`重複 ${ok} 件を削除しました`, {
          description: `${formatBytes(res.deletedBytes)} を回収しました。`,
        });
      } else {
        toast.error(`${ok} 件を削除・${failed} 件は失敗`, {
          description:
            res.outcomes.find((o) => !o.ok)?.error ?? "一部のファイルを削除できませんでした。",
        });
      }
      return res;
    } catch (e) {
      toast.error("削除に失敗しました", {
        description: e instanceof Error ? e.message : String(e),
      });
      return null;
    } finally {
      deleting = false;
    }
  }

  return {
    status: "idle",
    progress: { phase: "hash", processed: 0, total: 0 },
    result: null,
    elapsedMs: 0,
    strictness: "exact",
    threshold: 10,
    groups: [],
    rootHandle: null,
    setStrictness: (strictness) => {
      set({ strictness });
      void recluster();
    },
    setThreshold: (threshold) => {
      set({ threshold });
      void recluster();
    },
    runFiles: (files) => {
      set({ rootHandle: null }); // File[] 経路は永続ハンドルが無く削除不可。
      return runIndex(() => runScan(files, getPool(), POOL_SIZE, onProgress));
    },
    runFolder: (handle) => {
      set({ rootHandle: handle }); // 削除に使う root ハンドルを保持。
      return runIndex(() => scanFolder(handle, getPool(), POOL_SIZE, onProgress));
    },
    deleteDuplicates,
  };
});
