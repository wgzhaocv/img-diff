import { create } from "zustand";
import { toast } from "sonner";
import { runScan, scanFolder, type ScanProgress, type ScanResult } from "@/lib/scan";
import { clusterGroup, type DupGroup, type Strictness } from "@/lib/core";
import { applyDeletions, planDeletions, type CleanResult } from "@/lib/clean";
import { requestWritePermission } from "@/lib/fsaccess";
import { formatBytes, errText } from "@/lib/format";
import { defaultPoolSize, poolRef } from "@/lib/workerPool";
import { rafThrottle } from "@/lib/rafThrottle";

// scan 画面の状態ストア（zustand）。コンポーネント外に持つのでルート切替でアンマウントされても
// スキャン結果・厳密度・グループ・進捗が保持される。ワーカープールもここで使い回す。

const POOL_SIZE = defaultPoolSize();
const pool = poolRef(POOL_SIZE); // 破棄後も作り直せる持ち手（workerPool.ts）。
let running = false; // スキャンの二重起動防止。
let deleting = false; // 実削除の二重起動防止。
let clusterToken = 0; // クラスタリングの競合（古い結果の上書き）を防ぐ単調トークン。
/**
 * **最後に成功したクラスタリングの組み合わせ。** 画面へ戻るたびに `ScanScreen` の debounce が
 * 同じしきい値を押し込んでくるので、これが無いと往復のたびに全対比較をやり直す。
 *
 * 値ではなく**成功したかどうか**で持つのが要点 —— 単に「値が変わっていないなら戻る」にすると、
 * `clusterGroup` が投げた後に同じ値でやり直す道が消える（今はその往復が偶然の回復路になっている）。
 *
 * **`result` そのものは入れない。** 入れると、次のスキャンが走っている間じゅう前回の
 * `ScanResult`（画像一覧・`File` の Map・サムネ Blob の Map）が生き残る＝いちばんメモリが要る
 * 時間に 2 組が同時に居座る。代わりに `replaceResult` が差し替えのたびにこれを捨てる。
 */
let clustered: { strictness: Strictness; threshold: number | undefined } | null = null;

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
  /**
   * `result` を差し替える**唯一の口**。クラスタ済みの記録も一緒に捨てる。
   * ここを通さずに `result` を書くと、新しい結果に古い groups が残る。
   */
  function replaceResult(result: ScanResult | null, patch: Partial<ScanState> = {}): void {
    clustered = null;
    // **`groups` も一緒に捨てる。** groups は result から導いた物なので、作り直す前に
    // 残しておくと「result からは消えた path が groups には在る」状態になり得る
    // （削除の直後にクラスタリングが失敗すると、件数も回収量も古いまま、
    //   もう一度削除を押すと**既に消えた path を消そうとする**）。
    set({ result, groups: [], ...patch });
  }

  /**
   * 厳密度/しきい値/結果から**必要なときだけ**グループを計算して返す（切替は再スキャン不要・SPEC §2）。
   * 作り直す必要が無い / 競合で追い越された ときは `null`（＝ `groups` を書き換えない）。
   * **失敗したときは空配列**（今の入力に合う一覧を作れない以上、古い一覧を残さない）。
   *
   * **store をここで書かない。** 呼び出し側が「結果」と「所要」を 1 回の更新で書けるようにするため。
   * （`ScanScreen` は欄ごとに購読するようになったので全体の描き直しは起きないが、
   *   途中の状態が一瞬見えるのは変わらないので、まとめる方を残す。）
   */
  async function clusterIfNeeded(): Promise<DupGroup[] | null> {
    const { result, strictness, threshold } = get();
    if (!result) {
      clustered = null;
      return [];
    }
    // **しきい値は perceptual でしか効かない。** 効かないときは鍵から外す
    // （`exact` のままスライダを動かしても作り直さない）。
    const effective = strictness === "perceptual" ? threshold : undefined;
    if (clustered && clustered.strictness === strictness && clustered.threshold === effective) {
      return null; // 同じ入力で既に成功している。
    }
    const token = ++clusterToken;
    try {
      const groups = await clusterGroup(result.images, strictness, effective);
      if (token !== clusterToken) return null; // 新しい要求が追い越した。
      clustered = { strictness, threshold: effective };
      return groups;
    } catch (e) {
      if (token !== clusterToken) return null;
      clustered = null; // 失敗は覚えない（同じ指定でもう一度試せるようにする）。
      toast.error("グループ化に失敗しました", { description: String(e) });
      // **空を返す**（`null` = 触らない、ではない）。今の入力に対する groups を作れないのだから、
      // 前の入力で作った一覧を残してはいけない —— 厳密度を切り替えて失敗したときに、
      // タブは新しい値なのに一覧は前の値のまま、という食い違いになる。
      return [];
    }
  }

  /// 設定を変えたときのやり直し（結果だけを書く）。
  async function recluster(): Promise<void> {
    const groups = await clusterIfNeeded();
    if (groups) set({ groups });
  }

  // スキャン実行の共通ラッパ（二重起動防止・状態遷移・空結果/失敗の通知・計測）。
  async function runIndex(doScan: () => Promise<ScanResult>): Promise<void> {
    if (running) return;
    running = true;
    const releaseHold = pool.hold(); // 走行中は畳ませない（画面を離れても最後まで走る）
    onProgress.cancel(); // 前回の予約フレームが新しい実行の 0/N を上書きしないように
    replaceResult(null, {
      status: "scanning",
      groups: [],
      elapsedMs: 0, // 前回の値を、新しい実行の途中で見せない。
      progress: { phase: "hash", processed: 0, total: 0 },
    });
    const start = performance.now();
    try {
      const result = await doScan();
      if (result.images.length === 0) {
        toast.info("対象の画像が見つかりませんでした", {
          description: "jpg / png / webp / heic / avif / tiff などを含むフォルダを選んでください。",
        });
        set({ status: "idle" });
        return;
      }
      replaceResult(result, { status: "done" });
      // **クラスタリングまで含めて計る。** 先に `elapsedMs` を確定すると、グループ化が
      // 計測から丸ごと抜け落ちる（利用者が待っている時間はそこまで）。
      // groups と**同じ 1 回の更新**で書く —— 分けると結果一覧がもう一度丸ごと描き直される。
      const groups = await clusterIfNeeded();
      set({ ...(groups ? { groups } : {}), elapsedMs: Math.round(performance.now() - start) });
    } catch (e) {
      toast.error("スキャンに失敗しました", {
        description: errText(e),
      });
      set({ status: "idle" });
    } finally {
      running = false;
      releaseHold();
    }
  }

  // **フレームに 1 回へ合流させる。** worker の完了ごとに呼ばれるので、小さい画像だと
  // 秒間数百回に達する（convert 側の実測で最大 ~580 回/秒）。そのたびに set すると
  // 画面がまるごと描き直される。進捗バーはフレームに 1 回で足りる。
  const onProgress = rafThrottle<ScanProgress>((progress) => set({ progress }));

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
        replaceResult({
          ...result,
          images: result.images.filter((r) => !deleted.has(r.path)),
          fileByPath,
          thumbByPath,
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
        description: errText(e),
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
      return runIndex(() => runScan(files, pool.get(), POOL_SIZE, onProgress));
    },
    runFolder: (handle) => {
      set({ rootHandle: handle }); // 削除に使う root ハンドルを保持。
      return runIndex(() => scanFolder(handle, pool.get(), POOL_SIZE, onProgress));
    },
    deleteDuplicates,
  };
});
