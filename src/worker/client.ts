/**
 * 主线程侧的 Worker 封装。
 *
 * 一次只跑一个任务（大文件解密会吃满一个核，串行更稳，内存峰值也可控）。
 * 取消通过 `terminate()` 重建 Worker 实现——内核是同步循环，Worker 在解密期间
 * 无法处理新消息，只有终止线程才能真正中断。
 */
import type { DecryptOutcome, VaultSnapshot } from '../core/types';
import { readBlobBuffer } from '../core/compat';
import type { BufferRef, SerializedOutcome, WorkerRequest, WorkerResponse } from './protocol';

export interface DecryptJobOptions {
  fileName: string;
  ekey?: string;
  vault?: VaultSnapshot;
  onProgress?: (ratio: number) => void;
}

export class DecryptAbortError extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = 'DecryptAbortError';
  }
}

function viewOf(ref: BufferRef): Uint8Array {
  return new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength);
}

/**
 * 反序列化：与 worker 端的 serialize 对称，用展开语法透传所有标量字段，
 * 只把 `audio` / `cover` 的「buffer + 偏移 + 长度」还原成视图。新增字段（如 keySource）无需改动。
 */
function deserialize(outcome: SerializedOutcome): DecryptOutcome {
  if (outcome.status !== 'ok') return outcome;
  const { audio, cover, ...rest } = outcome;
  return {
    ...rest,
    data: viewOf(audio),
    cover: cover ? { mime: cover.mime, data: viewOf(cover) } : undefined,
  };
}

interface PendingJob {
  id: string;
  /**
   * 是否已被取消。
   *
   * `decrypt()` 会先占位再 `await file.arrayBuffer()`；读取期间用户点「取消」时，
   * `cancel()` 只能把占位 job 标记为 cancelled 并 reject，无法阻止读取继续完成——
   * 因此读取结束后必须再验一次这个标志，确认不会把已取消的任务 post 给 Worker。
   */
  cancelled: boolean;
  resolve: (outcome: DecryptOutcome) => void;
  reject: (error: unknown) => void;
  onProgress?: (ratio: number) => void;
}

export class DecryptWorkerClient {
  private worker: Worker | null = null;
  private pending: PendingJob | null = null;
  private seq = 0;

  private spawn(): Worker {
    const worker = new Worker(new URL('./decrypt.worker.ts', import.meta.url));
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      this.handle(event.data);
    });
    worker.addEventListener('error', (event) => {
      const job = this.pending;
      this.pending = null;
      this.worker = null;
      worker.terminate();
      job?.reject(new Error(`解密线程异常：${event.message || '未知错误'}`));
    });
    this.worker = worker;
    return worker;
  }

  private ensureWorker(): Worker {
    return this.worker ?? this.spawn();
  }

  private handle(message: WorkerResponse): void {
    const job = this.pending;
    if (!job || job.id !== message.id) return;

    switch (message.type) {
      case 'progress':
        job.onProgress?.(message.ratio);
        return;
      case 'aborted':
        this.pending = null;
        job.reject(new DecryptAbortError());
        return;
      case 'error':
        this.pending = null;
        job.reject(new Error(message.message));
        return;
      case 'result':
        this.pending = null;
        job.resolve(deserialize(message.outcome));
        return;
    }
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  /**
   * 提交一个解密任务。`file` 的字节会被转移给 Worker（主线程不再持有）。
   *
   * 竞态防护（P1-1）：**先占位、再读取**。
   * 旧实现是 `await file.arrayBuffer()` 之后才 `this.pending = ...`，
   * 这段窗口里 `cancel()` 会因为「没有 pending」而空转，读取完成后任务照常提交，
   * 已取消的行又变回「完成」。现在占位期就占住 pending（`busy` 也为真），
   * 取消会把占位任务标记 cancelled 并 reject；读取完成后若发现已取消/已被替换，
   * 直接抛 DecryptAbortError 且**不发 postMessage**。
   */
  async decrypt(file: Blob, options: DecryptJobOptions): Promise<DecryptOutcome> {
    if (this.pending) throw new Error('上一个解密任务尚未结束');

    const id = `job-${++this.seq}`;
    let settle!: { resolve: (o: DecryptOutcome) => void; reject: (e: unknown) => void };
    const promise = new Promise<DecryptOutcome>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const job: PendingJob = {
      id,
      cancelled: false,
      resolve: settle.resolve,
      reject: settle.reject,
      onProgress: options.onProgress,
    };
    this.pending = job;
    const worker = this.ensureWorker();

    void (async () => {
      try {
        const buffer = await readBlobBuffer(file);
        if (job.cancelled || this.pending !== job) {
          // 读取期间被取消（或被新任务取代）：不提交、不产生任何结果
          if (this.pending === job) this.pending = null;
          job.reject(new DecryptAbortError());
          return;
        }
        const message: WorkerRequest = {
          type: 'decrypt',
          id,
          fileName: options.fileName,
          ekey: options.ekey,
          vault: options.vault,
          buffer,
        };
        worker.postMessage(message, [buffer]);
      } catch (error) {
        if (this.pending === job) this.pending = null;
        job.reject(error);
      }
    })();

    return promise;
  }

  /** 中断当前任务（含「正在读取文件」的占位阶段；终止线程，下次任务自动重建）。 */
  cancel(): void {
    const job = this.pending;
    if (!job) return;
    this.pending = null;
    job.cancelled = true;
    this.worker?.terminate();
    this.worker = null;
    job.reject(new DecryptAbortError());
  }

  dispose(): void {
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
  }
}

/** 全局单例：UI 直接复用，减少 Worker 反复创建的开销。 */
export const decryptClient = new DecryptWorkerClient();
