/**
 * 转码 Worker 的主线程客户端。一次一个任务；取消 = terminate + 下次重建。
 */
export interface TranscodeOutcome {
  data: Uint8Array;
  sampleRate: number;
  channels: number;
  bitrate: number;
  seconds: number;
}

type Response =
  | { type: 'progress'; id: string; ratio: number }
  | {
      type: 'done';
      id: string;
      buffer: ArrayBuffer;
      sampleRate: number;
      channels: number;
      bitrate: number;
      seconds: number;
    }
  | { type: 'error'; id: string; message: string };

export class TranscodeWorkerClient {
  private worker: Worker | null = null;
  private reject: ((reason: Error) => void) | null = null;

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./transcode.worker.ts', import.meta.url));
    }
    return this.worker;
  }

  run(input: Uint8Array, onProgress?: (ratio: number) => void): Promise<TranscodeOutcome> {
    if (this.reject) throw new Error('上一次转码尚未结束');
    const worker = this.ensureWorker();

    // 复制一份再 transfer：调用方仍保留原始 OGG，转码失败可以回退
    const copy = input.slice();

    return new Promise<TranscodeOutcome>((resolve, reject) => {
      this.reject = reject;
      const id = String(Date.now());

      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        this.reject = null;
      };

      const onMessage = (event: MessageEvent<Response>) => {
        const message = event.data;
        if (!message || message.id !== id) return;
        if (message.type === 'progress') {
          onProgress?.(message.ratio);
          return;
        }
        if (message.type === 'done') {
          cleanup();
          resolve({
            data: new Uint8Array(message.buffer),
            sampleRate: message.sampleRate,
            channels: message.channels,
            bitrate: message.bitrate,
            seconds: message.seconds,
          });
          return;
        }
        if (message.type === 'error') {
          cleanup();
          reject(new Error(message.message));
        }
      };

      const onError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || '转码线程异常'));
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ type: 'transcode', id, buffer: copy.buffer }, [copy.buffer]);
    });
  }

  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    const reject = this.reject;
    this.reject = null;
    reject?.(new Error('转码已取消'));
  }

  dispose(): void {
    this.cancel();
  }
}

export const transcodeClient = new TranscodeWorkerClient();
