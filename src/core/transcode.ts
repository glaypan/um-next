/**
 * OGG Vorbis → MP3。
 *
 * 为什么不用 WebAudio / ffmpeg.wasm：
 * - Safari 不原生支持 Ogg Vorbis，`decodeAudioData` 在 macOS 上直接失败；
 * - ffmpeg.wasm 核心 20MB+，对「离线、可装进 GitHub Pages」的定位太重。
 *
 * 这里用 libvorbis 的 WASM 解码器流式喂入（256 KiB/块），再用纯 JS 的 LAME 分块编码，
 * 内存峰值只跟单块 PCM 有关，不会把整首歌的 Float32 PCM（几分钟≈300MB）留在内存里。
 */
import { OggVorbisDecoder } from '@wasm-audio-decoders/ogg-vorbis';
import { Mp3Encoder } from '@breezystack/lamejs';

export interface OggToMp3Options {
  /** 0..1，按输入字节进度回调。 */
  onProgress?: (ratio: number) => void;
}

export interface OggToMp3Result {
  data: Uint8Array;
  sampleRate: number;
  channels: number;
  bitrate: number;
  seconds: number;
}

const FEED_CHUNK = 256 * 1024;
const PCM_BLOCK = 1152; // MP3 每帧 1152 个采样

/** 按采样率/声道挑一个合法且够用的 CBR 码率。 */
export function pickMp3Bitrate(sampleRate: number, channels: number): number {
  const stereo = channels > 1;
  if (sampleRate >= 44100) return stereo ? 320 : 192;
  if (sampleRate >= 32000) return stereo ? 160 : 128;
  if (sampleRate >= 22050) return stereo ? 128 : 96;
  if (sampleRate >= 16000) return stereo ? 96 : 64;
  if (sampleRate >= 11025) return stereo ? 64 : 48;
  return stereo ? 32 : 32;
}

function looksLikeOggVorbis(input: Uint8Array): boolean {
  if (input.length < 64) return false;
  if (String.fromCharCode(input[0], input[1], input[2], input[3]) !== 'OggS') return false;
  // Vorbis identification header: "\x01vorbis"；Opus 则是 "OpusHead"
  const probe = input.subarray(0, Math.min(input.length, 64 * 1024));
  const text = Array.from(probe, (byte) => String.fromCharCode(byte)).join('');
  return text.includes('vorbis');
}

function floatToInt16(source: Float32Array, offset: number, length: number, target: Int16Array): Int16Array {
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, source[offset + i] ?? 0));
    target[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return target.subarray(0, length);
}

/**
 * 转码入口。输入必须是 Ogg Vorbis；Opus 会抛出明确错误（QQ 音乐常见 .mgg 为 Vorbis）。
 */
export async function oggToMp3(input: Uint8Array, options: OggToMp3Options = {}): Promise<OggToMp3Result> {
  if (!looksLikeOggVorbis(input)) {
    throw new Error('不是可识别的 Ogg Vorbis 音频（可能是不支持的 Opus 编码）');
  }

  const decoder = new OggVorbisDecoder();
  await decoder.ready;

  const encoderRef: { current: Mp3Encoder | null } = { current: null };
  let sampleRate = 0;
  let channels = 0;
  let bitrate = 0;
  let totalSamples = 0;
  const parts: Uint8Array[] = [];
  const leftPcm = new Int16Array(PCM_BLOCK);
  const rightPcm = new Int16Array(PCM_BLOCK);

  const consume = (decoded: {
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
  }) => {
    if (decoded.samplesDecoded <= 0) return;
    if (!encoderRef.current) {
      sampleRate = decoded.sampleRate;
      channels = Math.min(2, decoded.channelData.length);
      if (channels < 1 || !sampleRate) return;
      bitrate = pickMp3Bitrate(sampleRate, channels);
      encoderRef.current = new Mp3Encoder(channels, sampleRate, bitrate);
    }
    const encoder = encoderRef.current;
    for (let i = 0; i < decoded.samplesDecoded; i += PCM_BLOCK) {
      const length = Math.min(PCM_BLOCK, decoded.samplesDecoded - i);
      const left = floatToInt16(decoded.channelData[0], i, length, leftPcm);
      const right =
        channels > 1 ? floatToInt16(decoded.channelData[1], i, length, rightPcm) : undefined;
      const chunk = right ? encoder.encodeBuffer(left, right) : encoder.encodeBuffer(left);
      if (chunk.length > 0) parts.push(new Uint8Array(chunk));
    }
    totalSamples += decoded.samplesDecoded;
  };

  try {
    options.onProgress?.(0);
    for (let offset = 0; offset < input.length; offset += FEED_CHUNK) {
      const end = Math.min(offset + FEED_CHUNK, input.length);
      consume(await decoder.decode(input.subarray(offset, end)));
      options.onProgress?.(end / input.length);
    }
    consume(await decoder.flush());
  } finally {
    decoder.free();
  }

  const encoder = encoderRef.current;
  if (!encoder || totalSamples === 0) {
    throw new Error('没有解码出可用的 Vorbis 音频数据');
  }

  const tail = encoder.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail));

  let totalLength = 0;
  for (const part of parts) totalLength += part.length;
  const data = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of parts) {
    data.set(part, cursor);
    cursor += part.length;
  }

  return {
    data,
    sampleRate,
    channels,
    bitrate,
    seconds: totalSamples / sampleRate,
  };
}
