import type { WorkerRequest, WorkerResponse } from "@/lib/hashTypes";

/**
 * プールの破棄（= 利用者による中断）で submit が失敗したことを表す。
 *
 * **1 件ごとの変換失敗と区別できる型が要る。** 区別できないと、編排層の per-file な
 * try/catch が中断の reject まで「その 1 件が失敗した」として飲み込み、
 * 残り全部を failed として記録したうえで**正常終了**してしまう（＝中断したのに
 * 「N 件変換・M 件失敗」と表示される）。
 */
export class PoolAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolAbortError";
  }
}

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: unknown) => void };
type Waiting = { req: WorkerRequest; transfer: Transferable[] } & Pending;

// wasm-vips + imgdiff-wasm を持つワーカーの固定プール（1 ワーカー = 同時 1 件）。
// 各ワーカーは初回メッセージで wasm-vips / imgdiff-wasm を一度だけ初期化して使い回す。
// ワーカー障害（モジュール読み込み失敗・受信失敗）は onerror/onmessageerror で拾い、
// 該当 Promise を reject → 死んだワーカーを破棄して補充する（無言ハングを防ぐ）。
export class HashPool {
  private readonly size: number;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly pending = new Map<Worker, Pending>();
  private readonly queue: Waiting[] = [];
  private disposed = false;

  constructor(size: number) {
    this.size = Math.max(1, size);
    for (let i = 0; i < this.size; i++) this.idle.push(this.spawn());
  }

  private spawn(): Worker {
    const worker = new Worker(new URL("../workers/hash.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(worker);
      this.pending.delete(worker);
      this.idle.push(worker);
      this.pump();
      p?.resolve(ev.data);
    };
    // モジュール初期化失敗・受信失敗 → 応答が来ないので該当 Promise を reject し、
    // 死んだワーカーを捨てて新しいワーカーで補充する（さもないと scan が永久ハング）。
    const fail = (message: string) => {
      const p = this.pending.get(worker);
      this.pending.delete(worker);
      this.discard(worker);
      p?.reject(new Error(message));
      if (!this.disposed) {
        this.idle.push(this.spawn());
        this.pump();
      }
    };
    worker.onerror = () => fail("ワーカーの初期化/実行に失敗しました");
    worker.onmessageerror = () => fail("ワーカー応答の受信に失敗しました");
    this.workers.push(worker);
    return worker;
  }

  private discard(worker: Worker): void {
    worker.terminate();
    const w = this.workers.indexOf(worker);
    if (w >= 0) this.workers.splice(w, 1);
    const i = this.idle.indexOf(worker);
    if (i >= 0) this.idle.splice(i, 1);
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const task = this.queue.shift()!;
      this.pending.set(worker, task); // Waiting は Pending を満たす（resolve/reject を保持）。
      worker.postMessage(task.req, task.transfer);
    }
  }

  /// 1 件を処理する（op で hash / pixel）。空きワーカーが無ければキューに積む。
  submit(req: WorkerRequest, transfer: Transferable[]): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error("プールは破棄済みです"));
        return;
      }
      this.queue.push({ req, transfer, resolve, reject });
      this.pump();
    });
  }

  /// 破棄。走行中・待機中の Promise はすべて reject する（宙ぶらりを残さない）。
  /// **破棄したプールは再利用できない** — 作り直しは [`poolRef`] が面倒を見る。
  /// reject する理由は [`PoolAbortError`]。編排層が「1 件の失敗」と「中断」を区別できるようにする。
  terminate(reason = "処理が中断されました"): void {
    this.disposed = true;
    const aborted = new PoolAbortError(reason);
    for (const task of this.queue) task.reject(aborted);
    this.queue.length = 0;
    for (const p of this.pending.values()) p.reject(aborted);
    this.pending.clear();
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

/**
 * 作り直せるプールの持ち手。
 *
 * ストアが `let pool: HashPool | null` + `pool ??= new HashPool(n)` を各自持つと、
 * **`terminate()` した後もその破棄済みインスタンスを掴み続け**、以後の `submit` が全部 reject される
 * （中断ボタンを付けるまで誰も `terminate()` を呼んでいなかったので表に出ていなかった）。
 * 生成と破棄をここ 1 箇所に閉じ込めて、`reset()` の次の `get()` が必ず新しいプールを返すようにする。
 *
 * 機能ごとに別の持ち手を持つこと（共有すると、convert の中断が走行中の scan まで巻き込む）。
 */
export function poolRef(size: number): { get: () => HashPool; reset: (reason?: string) => void } {
  let pool: HashPool | null = null;
  return {
    get: () => (pool ??= new HashPool(size)),
    reset: (reason?: string) => {
      pool?.terminate(reason);
      pool = null;
    },
  };
}

/// 既定のプール本数（DESIGN §4: min(hardwareConcurrency, 8)）。
export function defaultPoolSize(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
  return Math.max(1, Math.min(cores ?? 4, 8));
}
