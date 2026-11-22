/**
 * 扫描 Worker 的主线程客户端：一次扫描一个目录，支持进度回调与取消。
 * 取消 = terminate（扫描循环是同步的，收不到消息，只能终止线程）。
 */
import type { ScanFileEntry, ScanProgress, ScanResult, ScanTarget } from './scan.worker';

interface DoneMessage extends ScanResult {
  type: 'done';
}
interface ProgressMessage extends ScanProgress {
  type: 'progress';
}
type ScanResponse = DoneMessage | ProgressMessage | { type: 'error'; message: string };

export class ScanWorkerClient {
  private worker: Worker | null = null;
  private reject: ((reason: Error) => void) | null = null;

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./scan.worker.ts', import.meta.url));
    }
    return this.worker;
  }

  run(
    files: ScanFileEntry[],
    targets: ScanTarget[],
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<ScanResult> {
    if (this.reject) throw new Error('上一次扫描尚未结束');
    const worker = this.ensureWorker();

    return new Promise<ScanResult>((resolve, reject) => {
      this.reject = reject;

      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        this.reject = null;
      };

      const onMessage = (event: MessageEvent<ScanResponse>) => {
        const message = event.data;
        if (!message || typeof message !== 'object') return;
        if (message.type === 'progress') {
          const { type: _type, ...progress } = message;
          onProgress?.(progress);
          return;
        }
        if (message.type === 'done') {
          cleanup();
          const { type: _type, ...result } = message;
          resolve(result);
          return;
        }
        if (message.type === 'error') {
          cleanup();
          reject(new Error(message.message));
        }
      };

      const onError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || '扫描线程异常'));
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({
        type: 'scan',
        files,
        targets,
      });
    });
  }

  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    const reject = this.reject;
    this.reject = null;
    reject?.(new Error('扫描已取消'));
  }

  dispose(): void {
    this.cancel();
  }
}

export const scanClient = new ScanWorkerClient();
