/**
 * 音频容器魔数识别。
 *
 * 用途有两个：
 *  1. 判定解密是否成功（QMC 没有签名字段，只能「解出来像不像音频」）——密钥错误时输出是噪声，
 *     不会命中任何魔数，因此 detect 能可靠地返回 bad-key。
 *  2. 推断输出扩展名（NCM 的 metadata 可能缺失或 format 字段不可信）。
 */
import { startsWithAscii } from './bytes';

export interface AudioFormat {
  ext: string;
  mime: string;
}

/**
 * 解析 MPEG 音频帧头（MP3 / MP2 / MP1 共用）。
 *
 * 为什么需要：QMC 没有签名字段，只能「解出来像不像音频」来判定密钥是否正确。
 * 早先只校验 `0xFF 0xE?` 两个字节，随机数据约有 1/2048 的概率误判成 MP3，
 * 会让错误密钥蒙混过关（用户拿到噪声文件，UI 还显示完成）。
 * 这里按 ISO/IEC 11172-3 校验完整帧头：11 位 sync、version ≠ 01、layer ≠ 00、
 * bitrateIndex ∈ 1..14、sampleRateIndex ≠ 3。
 */
export interface MpegFrameHeader {
  /** 1 = MPEG1，2 = MPEG2，25 = MPEG2.5。 */
  version: 1 | 2 | 25;
  /** 1 = Layer I，2 = Layer II，3 = Layer III。 */
  layer: 1 | 2 | 3;
  /** kbps。 */
  bitrate: number;
  /** Hz。 */
  sampleRate: number;
  padding: boolean;
  channelMode: number;
  /** 整帧字节数（含 4 字节帧头与 padding）。 */
  frameLength: number;
}

/* 索引 0 = free（不校验，直接拒绝），索引 15 = bad。 */
const BITRATE_TABLE: Record<string, readonly number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

const SAMPLE_RATE_TABLE: Record<'1' | '2' | '2.5', readonly number[]> = {
  '1': [44100, 48000, 32000, 0],
  '2': [22050, 24000, 16000, 0],
  '2.5': [11025, 12000, 8000, 0],
};

/** 解析 `offset` 处的 MPEG 音频帧头；不合法返回 null。 */
export function parseMpegFrameHeader(buf: Uint8Array, offset = 0): MpegFrameHeader | null {
  if (offset < 0 || offset + 4 > buf.length) return null;
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];

  // sync：11 位全 1
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionId = (b1 >> 3) & 0x03; // 0 = 2.5，1 = reserved，2 = 2，3 = 1
  if (versionId === 1) return null;
  const layerId = (b1 >> 1) & 0x03; // 0 = reserved，1 = III，2 = II，3 = I
  if (layerId === 0) return null;

  const bitrateIndex = (b2 >> 4) & 0x0f;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f) return null;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (sampleRateIndex === 3) return null;

  const padding = (b2 & 0x02) !== 0;
  const versionKey: '1' | '2' | '2.5' = versionId === 3 ? '1' : versionId === 2 ? '2' : '2.5';
  const layer = (4 - layerId) as 1 | 2 | 3;
  const tableKey = `${versionKey === '1' ? 1 : 2}-${layer}`;
  const bitrate = BITRATE_TABLE[tableKey][bitrateIndex];
  const sampleRate = SAMPLE_RATE_TABLE[versionKey][sampleRateIndex];
  if (bitrate === 0 || sampleRate === 0) return null;

  const pad = padding ? 1 : 0;
  let frameLength: number;
  if (layer === 1) {
    // Layer I：每帧 12 个样本 × 4 字节槽
    frameLength = Math.floor((12 * bitrate * 1000) / sampleRate + pad) * 4;
  } else if (layer === 3 && versionKey !== '1') {
    // MPEG2 / MPEG2.5 的 Layer III 每帧只有 576 个样本
    frameLength = Math.floor((72 * bitrate * 1000) / sampleRate + pad);
  } else {
    frameLength = Math.floor((144 * bitrate * 1000) / sampleRate + pad);
  }
  if (frameLength < 4) return null;

  return {
    version: versionKey === '1' ? 1 : versionKey === '2' ? 2 : 25,
    layer,
    bitrate,
    sampleRate,
    padding,
    channelMode: (b3 >> 6) & 0x03,
    frameLength,
  };
}

/**
 * 是否像 MPEG 音频流。
 *
 * 数据够长时会再验证「下一帧」也满足同一套帧头（按帧长 + padding 跳帧）；
 * 探测缓冲常常不足一帧（detect 只截一段），这时首帧校验通过即可，
 * 否则会把合法 MP3 判死。
 */
export function looksLikeMpegAudio(buf: Uint8Array, offset = 0): boolean {
  const first = parseMpegFrameHeader(buf, offset);
  if (!first) return false;
  const nextOffset = offset + first.frameLength;
  if (nextOffset + 4 > buf.length) return true;
  return parseMpegFrameHeader(buf, nextOffset) !== null;
}

/**
 * 判断一段数据开头是否是已知音频容器。`buf` 至少 16 字节时判断最准（不足也可判定）。
 * 返回 null 表示不像音频。
 */
export function guessAudioFormat(buf: Uint8Array): AudioFormat | null {
  if (buf.length < 4) return null;

  if (startsWithAscii(buf, 'fLaC')) return { ext: 'flac', mime: 'audio/flac' };
  if (startsWithAscii(buf, 'OggS')) return { ext: 'ogg', mime: 'audio/ogg' };
  if (startsWithAscii(buf, 'RIFF')) return { ext: 'wav', mime: 'audio/wav' };
  if (startsWithAscii(buf, 'MAC ')) return { ext: 'ape', mime: 'audio/x-ape' };
  if (startsWithAscii(buf, 'wvpk')) return { ext: 'wv', mime: 'audio/x-wavpack' };
  if (startsWithAscii(buf, 'DSD ')) return { ext: 'dsf', mime: 'audio/x-dsf' };
  // MP4 系：ftyp 落在 offset 4
  if (buf.length >= 8 && startsWithAscii(buf.subarray(4), 'ftyp')) {
    return { ext: 'm4a', mime: 'audio/mp4' };
  }
  // MP3：ID3v2 标签，或完整的 MPEG 帧头（含「下一帧」交叉校验）
  if (startsWithAscii(buf, 'ID3')) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (looksLikeMpegAudio(buf)) return { ext: 'mp3', mime: 'audio/mpeg' };

  return null;
}

/** 便捷判定：是否像音频。 */
export function looksLikeAudio(buf: Uint8Array): boolean {
  return guessAudioFormat(buf) !== null;
}

/** 按扩展名给 MIME（下载时用）。 */
export function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'flac':
      return 'audio/flac';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'm4a':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'ape':
      return 'audio/x-ape';
    case 'wv':
      return 'audio/x-wavpack';
    case 'dsf':
      return 'audio/x-dsf';
    default:
      return 'application/octet-stream';
  }
}
