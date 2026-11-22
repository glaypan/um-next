/**
 * 网易云音乐 NCM 解析（含 3.x 容错）。
 *
 * 结构（全部小端）：
 *   "CTENFDAM"(8) | ncmVersion(1) | clientVersion(1)
 *   | u32 keyLen | contentKey(keyLen)      → XOR 0x64 + AES-128-ECB（key `hzHRAmso5kInbaxW`）
 *   | u32 metaLen | metadata(metaLen)      → XOR 0x63 + "163 key(Don't modify):" + base64 + AES-128-ECB
 *   | u32 crc32                            → 覆盖 [0, crc 字段起始)
 *   | coverVersion(1) | u32 frameLen | u32 image1Len | image1 | image2
 *   | audio                               → 每字节 XOR keystream[offset % 256]
 *
 * 3.x 容错（只告警不失败）：coverVersion != 1、image1Len == 0（无封面）、frameLen == 0、
 * metadata 为空、CRC 不匹配。上游 Rust 对 CRC / coverVersion 是硬失败，但用户目标是「把歌解出来」，
 * 因此这里全部降级为 warning（brief §7 / 调查报告 §5.3 第 11、12 条）。
 */
import { aes128EcbDecryptPkcs7 } from '../aes128';
import {
  base64Decode,
  crc32,
  latin1Decode,
  readU32LE,
  startsWithAscii,
  utf8Decode,
} from '../bytes';
import { guessAudioFormat } from '../audio';
import { DecryptAbortedError, type CoverImage, type TrackMeta } from '../types';

export const NCM_MAGIC = 'CTENFDAM';
/** content key 的 AES-128 密钥。 */
export const NCM_CONTENT_KEY = 'hzHRAmso5kInbaxW';
/** metadata 的 AES-128 密钥（第 9 字节是反斜杠 0x5C）。 */
export const NCM_METADATA_KEY = "#14ljk_!\\]&0U<'(";
const CONTENT_KEY_PREFIX = 'neteasecloudmusic';
const METADATA_PREFIX = "163 key(Don't modify):";
const METADATA_JSON_PREFIX = 'music:';

const CHUNK_SIZE = 4 * 1024 * 1024;

export class NcmParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NcmParseError';
  }
}

/**
 * 「文件不完整」这一类错误：头部字段缺失、长度字段越界、没有音频段。
 *
 * 单独成类是为了让 UI 能给出「可能没下载完」的提示，而不是笼统的「格式不支持」。
 * 继承 NcmParseError，因此既有的 catch (e instanceof NcmParseError) 与文案断言都不受影响。
 */
export class NcmTruncatedError extends NcmParseError {
  constructor(message: string) {
    super(message);
    this.name = 'NcmTruncatedError';
  }
}

export interface NcmParseOptions {
  onProgress?: (ratio: number) => void;
  isAborted?: () => boolean;
}

export interface NcmResult {
  /** 音频明文（入参缓冲区的视图，未复制）。 */
  data: Uint8Array;
  meta?: TrackMeta;
  cover?: CoverImage;
  format?: string;
  warnings: string[];
}

/**
 * 只看 8 字节 magic。用于把「以 CTENFDAM 开头但被截断」的文件也识别成 NCM，
 * 从而给出「文件不完整」而不是「无法识别」。
 */
export function hasNcmMagic(buf: Uint8Array): boolean {
  return buf.length >= NCM_MAGIC.length && startsWithAscii(buf, NCM_MAGIC);
}

/** 快速判定（要求至少 10 字节，能容纳 magic + 版本号），带 magic 的短文件请用 hasNcmMagic。 */
export function isNcm(buf: Uint8Array): boolean {
  return buf.length >= 10 && hasNcmMagic(buf);
}

/** 解 content key：XOR 0x64 → AES-128-ECB → 去 `neteasecloudmusic` 前缀。 */
export function decryptContentKey(encrypted: Uint8Array): Uint8Array {
  if (encrypted.length === 0) throw new NcmParseError('NCM 的 content key 为空');
  const xored = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) xored[i] = encrypted[i] ^ 0x64;
  const plain = aes128EcbDecryptPkcs7(xored, NCM_CONTENT_KEY);
  if (!startsWithAscii(plain, CONTENT_KEY_PREFIX)) {
    throw new NcmParseError('NCM 的 content key 解密失败（前缀不匹配）');
  }
  return plain.subarray(CONTENT_KEY_PREFIX.length);
}

/** 解 metadata：XOR 0x63 → 去前缀 → base64 → AES-128-ECB → 去 `music:` → JSON。 */
export function decryptMetadata(encrypted: Uint8Array): Record<string, unknown> {
  const xored = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) xored[i] = encrypted[i] ^ 0x63;
  const text = latin1Decode(xored);
  if (!text.startsWith(METADATA_PREFIX)) {
    throw new NcmParseError('NCM 的 metadata 解密失败（前缀不匹配）');
  }
  const b64 = text.slice(METADATA_PREFIX.length);
  const raw = base64Decode(b64);
  const json = aes128EcbDecryptPkcs7(raw, NCM_METADATA_KEY);
  const jsonText = utf8Decode(json);
  if (!jsonText.startsWith(METADATA_JSON_PREFIX)) {
    throw new NcmParseError('NCM 的 metadata 解密失败（music: 前缀缺失）');
  }
  const parsed: unknown = JSON.parse(jsonText.slice(METADATA_JSON_PREFIX.length));
  if (parsed === null || typeof parsed !== 'object') {
    throw new NcmParseError('NCM 的 metadata 不是对象');
  }
  return parsed as Record<string, unknown>;
}

/**
 * NCM 音频流 keystream（256 字节）。
 * KSA 为标准 RC4（模 256），但 PRGA 是「取出 s[i+1] 后不再自增 i」的简化式。
 */
export function buildNcmKeyStream(contentKey: Uint8Array): Uint8Array {
  if (contentKey.length === 0) throw new NcmParseError('NCM content key 为空');
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let last = 0;
  for (let i = 0; i < 256; i++) {
    const c = (box[i] + last + contentKey[i % contentKey.length]) & 0xff;
    last = c;
    // 真正的 swap（保留 box[i] 的旧值）。写成 `box[i] = box[c]; box[c] = i` 只在
    // box[i] === i 时等价，遇到已被前面交换过的位置就会算错——上游测试向量可区分。
    const tmp = box[i];
    box[i] = box[c];
    box[c] = tmp;
  }
  const stream = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const ii = (i + 1) & 0xff;
    const jj = (box[ii] + ii) & 0xff;
    stream[i] = box[(box[ii] + box[jj]) & 0xff];
  }
  return stream;
}

/** 原地解密 NCM 音频流；`offset` 相对音频起点。 */
export function decryptNcmAudio(data: Uint8Array, offset: number, keyStream: Uint8Array): void {
  for (let i = 0; i < data.length; i++) {
    data[i] ^= keyStream[(offset + i) & 0xff];
  }
}

function toTrackMeta(raw: Record<string, unknown>): TrackMeta {
  const meta: TrackMeta = {};
  if (typeof raw.musicName === 'string') meta.title = raw.musicName;
  if (typeof raw.album === 'string') meta.album = raw.album;
  if (typeof raw.format === 'string') meta.format = raw.format;
  if (typeof raw.bitrate === 'number') meta.bitrate = raw.bitrate;
  if (typeof raw.duration === 'number') meta.duration = raw.duration;
  const artist = raw.artist;
  if (Array.isArray(artist)) {
    const names: string[] = [];
    for (const entry of artist) {
      if (Array.isArray(entry) && typeof entry[0] === 'string') names.push(entry[0]);
    }
    if (names.length > 0) meta.artist = names.join(' / ');
  }
  return meta;
}

function guessCoverMime(data: Uint8Array): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data.length >= 12 && startsWithAscii(data, 'RIFF') && startsWithAscii(data.subarray(8), 'WEBP')) {
    return 'image/webp';
  }
  if (data.length >= 6 && startsWithAscii(data, 'GIF8')) return 'image/gif';
  return 'image/jpeg';
}

/** 解析整个 NCM 文件。所有结构性错误抛 NcmParseError（中文信息）。 */
export function parseNcm(buf: Uint8Array, options: NcmParseOptions = {}): NcmResult {
  const warnings: string[] = [];
  const len = buf.length;

  if (!hasNcmMagic(buf)) throw new NcmParseError('不是有效的 NCM 文件（缺少 CTENFDAM 头）');

  let p = 8;
  // ncmVersion / clientVersion 不校验（3.x 出现过不同取值）
  p += 2;
  if (p + 4 > len) {
    throw new NcmTruncatedError('文件头被截断（关键字段缺失）');
  }

  const keyLen = readU32LE(buf, p);
  p += 4;
  if (keyLen === 0 || keyLen > 0x10000 || p + keyLen > len) {
    throw new NcmTruncatedError('content key 长度非法');
  }
  const encKey = buf.subarray(p, p + keyLen);
  p += keyLen;

  if (p + 4 > len) throw new NcmTruncatedError('文件头被截断（缺少 metadata 长度）');
  const metaLen = readU32LE(buf, p);
  p += 4;
  if (p + metaLen > len) throw new NcmTruncatedError('metadata 长度非法');
  const encMeta = buf.subarray(p, p + metaLen);
  p += metaLen;

  // CRC 覆盖 [0, p)，不含 crc 字段自身
  if (p + 4 > len) throw new NcmTruncatedError('文件头被截断（缺少 CRC）');
  const crcExpected = readU32LE(buf, p);
  const crcActual = crc32(buf, 0, p);
  if (crcExpected !== crcActual) {
    warnings.push(
      `CRC 校验不匹配（文件内 ${crcExpected.toString(16)}，实算 ${crcActual.toString(16)}），已忽略并继续解密`,
    );
  }
  p += 4;

  if (p + 9 > len) throw new NcmTruncatedError('文件头被截断（缺少封面信息）');
  const coverVersion = buf[p];
  p += 1;
  if (coverVersion !== 1) warnings.push(`未知的封面版本 ${coverVersion}，已按 version 1 解析`);

  const frameLen = readU32LE(buf, p);
  p += 4;
  const rawImage1Len = readU32LE(buf, p);
  p += 4;

  let image1Len = rawImage1Len;
  if (image1Len > frameLen) {
    warnings.push('封面长度字段异常（image1 > frameLen），已按 frameLen 截断');
    image1Len = frameLen;
  }
  if (p + frameLen > len) throw new NcmTruncatedError('封面数据越界');
  const image1 = buf.subarray(p, p + image1Len);
  p += frameLen;

  const audioOffset = p;
  if (audioOffset >= len) throw new NcmTruncatedError('文件不含音频数据');

  // content key（失败即无法继续）
  const contentKey = decryptContentKey(encKey);
  const keyStream = buildNcmKeyStream(contentKey);

  // metadata（失败只告警）
  let meta: TrackMeta | undefined;
  if (metaLen > 0) {
    try {
      meta = toTrackMeta(decryptMetadata(encMeta));
    } catch (err) {
      warnings.push(
        `元数据解析失败，已忽略：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let cover: CoverImage | undefined;
  if (image1Len > 0) {
    cover = { mime: guessCoverMime(image1), data: image1 };
  }

  // 音频解密（分块 + 进度）
  const audio = buf.subarray(audioOffset);
  for (let pos = 0; pos < audio.length; pos += CHUNK_SIZE) {
    if (options.isAborted?.()) throw new DecryptAbortedError();
    const end = Math.min(pos + CHUNK_SIZE, audio.length);
    decryptNcmAudio(audio.subarray(pos, end), pos, keyStream);
    options.onProgress?.(end / audio.length);
  }

  const detected = guessAudioFormat(audio);
  if (!detected) {
    throw new NcmParseError('NCM 解密后不是可识别的音频数据（content key 可能不正确）');
  }

  return { data: audio, meta, cover, format: meta?.format, warnings };
}
