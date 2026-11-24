/**
 * 转码 Worker：把解密后的 OGG Vorbis 转成 MP3。
 * 解码（libvorbis WASM）与编码（LAME）都吃 CPU，放主线程会卡住界面。
 */
import { oggToMp3 } from '../core/transcode';

interface TranscodeRequest {
  type: 'transcode';
  id: string;
  buffer: ArrayBuffer;
}

type TranscodeResponse =
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

const ctx = self as unknown as {
  postMessage(message: TranscodeResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<TranscodeRequest>) => void): void;
};

const PROGRESS_INTERVAL_MS = 80;

ctx.addEventListener('message', (event: MessageEvent<TranscodeRequest>) => {
  const message = event.data;
  if (!message || message.type !== 'transcode') return;

  let lastPost = 0;
  void (async () => {
    try {
      const result = await oggToMp3(new Uint8Array(message.buffer), {
        onProgress: (ratio) => {
          const now = Date.now();
          if (now - lastPost < PROGRESS_INTERVAL_MS && ratio < 1) return;
          lastPost = now;
          ctx.postMessage({ type: 'progress', id: message.id, ratio });
        },
      });
      const buffer = result.data.buffer as ArrayBuffer;
      ctx.postMessage(
        {
          type: 'done',
          id: message.id,
          buffer,
          sampleRate: result.sampleRate,
          channels: result.channels,
          bitrate: result.bitrate,
          seconds: result.seconds,
        },
        [buffer],
      );
    } catch (error) {
      ctx.postMessage({
        type: 'error',
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});
