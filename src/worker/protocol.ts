/**
 * 主线程 ↔ Worker 的消息协议（结构化克隆 + Transferable）。
 *
 * outcome 用「展开 + 抽走二进制字段」的方式透传：除 `data` / `cover` 之外的字段
 * （含以后新增的 keySource、meta 扩展等）都自动跟随 `DecryptOutcome`，不需要维护两份字段表。
 */
import type {
  DecryptBadKey,
  DecryptNeedKey,
  DecryptOk,
  DecryptUnsupported,
  VaultSnapshot,
} from '../core/types';

export interface DecryptRequestMessage {
  type: 'decrypt';
  id: string;
  fileName: string;
  ekey?: string;
  vault?: VaultSnapshot;
  /** 原始文件字节（transfer 进来，避免复制）。 */
  buffer: ArrayBuffer;
}

export interface CancelMessage {
  type: 'cancel';
  id: string;
}

export type WorkerRequest = DecryptRequestMessage | CancelMessage;

/** 一段字节在（可能共享的）ArrayBuffer 中的位置。 */
export interface BufferRef {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
}

/** ok 结果：去掉可变长二进制，换成「buffer + 偏移 + 长度」。 */
export type SerializedOk = Omit<DecryptOk, 'data' | 'cover'> & {
  audio: BufferRef;
  cover?: { mime: string } & BufferRef;
};

/** 后三种状态本来就没有二进制字段，原样透传。 */
export type SerializedOutcome =
  | SerializedOk
  | DecryptNeedKey
  | DecryptBadKey
  | DecryptUnsupported;

export type WorkerResponse =
  | { type: 'progress'; id: string; ratio: number }
  | { type: 'result'; id: string; outcome: SerializedOutcome }
  | { type: 'aborted'; id: string }
  | { type: 'error'; id: string; message: string };
