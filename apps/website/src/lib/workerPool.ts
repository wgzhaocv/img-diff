import type { WorkerRequest, WorkerResponse } from "@/lib/hashTypes";

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
  terminate(): void {
    this.disposed = true;
    const aborted = new Error("スキャンが中断されました");
    for (const task of this.queue) task.reject(aborted);
    this.queue.length = 0;
    for (const p of this.pending.values()) p.reject(aborted);
    this.pending.clear();
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

/// 既定のプール本数（DESIGN §4: min(hardwareConcurrency, 8)）。
export function defaultPoolSize(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
  return Math.max(1, Math.min(cores ?? 4, 8));
}
