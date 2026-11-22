/**
 * 解密 Worker：主线程只负责读写文件与 UI，全部解析/解密都在这里做，避免卡界面。
 *
 * 进度节流：内核每 4 MiB 回调一次，这里再按 50ms 节流（≤20 次/秒），最后一帧必发。
 * 取消：内核是同步循环，Worker 事件循环在解密期间拿不到新消息，因此取消由主线程
 * `terminate()` + 重建 Worker 实现（见 client.ts）；这里仍保留 cancel 分支用于排队场景。
 */
import { decryptFile } from '../core/detect';
import { DecryptAbortedError, type DecryptOutcome } from '../core/types';
import type { SerializedOk, SerializedOutcome, WorkerRequest, WorkerResponse } from './protocol';

const PROGRESS_INTERVAL_MS = 50;

const ctx = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
};

let aborted = false;

/**
 * 把内核结果转成可结构化克隆的消息。
 *
 * 非 ok 的结果原样透传；ok 的结果用展开语法把 `data` / `cover` 换成长度描述，
 * 其余字段（ext/cipher/meta/keySource/warnings…）自动跟随，新增字段无需改这里。
 */
function serialize(outcome: DecryptOutcome): {
  payload: SerializedOutcome;
  transfer: Transferable[];
} {
  if (outcome.status !== 'ok') {
    return { payload: outcome, transfer: [] };
  }

  const { data, cover, ...rest } = outcome;

  // 内核只会产出基于 ArrayBuffer 的视图（不会出现 SharedArrayBuffer）
  const audioBuffer = data.buffer as ArrayBuffer;
  const transfer: Transferable[] = [audioBuffer];
  const payload: SerializedOk = {
    ...rest,
    audio: {
      buffer: audioBuffer,
      byteOffset: data.byteOffset,
      byteLength: data.byteLength,
    },
  };
  if (cover) {
    const coverBuffer = cover.data.buffer as ArrayBuffer;
    payload.cover = {
      mime: cover.mime,
      buffer: coverBuffer,
      byteOffset: cover.data.byteOffset,
      byteLength: cover.data.byteLength,
    };
    // 封面通常与音频共享同一个 ArrayBuffer，只 transfer 一次
    if (!transfer.includes(coverBuffer)) transfer.push(coverBuffer);
  }
  return { payload, transfer };
}

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === 'cancel') {
    aborted = true;
    return;
  }
  if (message.type !== 'decrypt') return;

  const { id, fileName, ekey, vault, buffer } = message;
  aborted = false;
  let lastPost = 0;

  try {
    const outcome = decryptFile(new Uint8Array(buffer), {
      fileName,
      ekey,
      vault,
      isAborted: () => aborted,
      onProgress: (ratio) => {
        const now = Date.now();
        if (ratio >= 1 || now - lastPost >= PROGRESS_INTERVAL_MS) {
          lastPost = now;
          ctx.postMessage({ type: 'progress', id, ratio });
        }
      },
    });
    const { payload, transfer } = serialize(outcome);
    ctx.postMessage({ type: 'result', id, outcome: payload }, transfer);
  } catch (err) {
    if (err instanceof DecryptAbortedError) {
      ctx.postMessage({ type: 'aborted', id });
    } else {
      ctx.postMessage({
        type: 'error',
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
});
