/**
 * 测试用的合成容器构造器（**仅测试代码**，不参与生产打包）。
 *
 * 目的：让各测试文件不必重复 N 份「AES 加密 metadata + XOR + 拼接 + CRC」的样板；
 * 所有构造都复用 `src/core` 里的真实实现（加密函数、keystream、CRC），
 * 不做任何算法上的「测试内重写」，避免测试与实现同时写错。
 */
import { aes128EcbEncryptPkcs7 } from '../../aes128';
import {
  base64Encode,
  concatBytes,
  crc32,
  latin1Encode,
  writeU32BE,
  writeU32LE,
} from '../../bytes';
import { NCM_CONTENT_KEY, NCM_METADATA_KEY, buildNcmKeyStream } from '../../ncm/index';
import { EKEY_SIMPLE_KEY, EKEY_V2_KEY1, EKEY_V2_KEY2, EKEY_V2_PREFIX } from '../../qmc/ekey';
import { tcTeaCbcEncrypt } from '../../tea';

/** 生成一段可预测的「假音频」：合法魔数 + 由长度推导的填充。 */
export function makeFakeAudio(size = 300, magic = 'fLaC'): Uint8Array {
  const audio = new Uint8Array(size);
  const head = latin1Encode(magic);
  audio.set(head.subarray(0, Math.min(head.length, size)), 0);
  for (let i = head.length; i < size; i++) audio[i] = (i * 31 + 7) & 0xff;
  return audio;
}

function u32le(value: number): Uint8Array {
  const b = new Uint8Array(4);
  writeU32LE(b, 0, value);
  return b;
}

function u32be(value: number): Uint8Array {
  const b = new Uint8Array(4);
  writeU32BE(b, 0, value);
  return b;
}

/** 把明文字符串按 NUL 补齐到 `total` 字节，并按 UTF-16LE（低字节在前的 ASCII）写入。 */
function utf16leAscii(str: string, total: number): Uint8Array {
  const out = new Uint8Array(total);
  for (let i = 0; i < str.length && i * 2 + 1 < total; i++) out[i * 2] = str.charCodeAt(i) & 0xff;
  return out;
}

export const TEST_CONTENT_KEY = latin1Encode('0123456789abcdefKEY-KEY-KEY-KEY-KEY-');

export interface BuildNcmOptions {
  audio?: Uint8Array;
  contentKey?: Uint8Array;
  /** null → metaLen = 0（3.x 无 metadata） */
  meta?: Record<string, unknown> | null;
  /** null / undefined → 无封面（frameLen = 0） */
  cover?: Uint8Array | null;
  /** 覆盖封面版本字节；null → 不写（保持 1） */
  coverVersion?: number;
  /** 覆盖 frameLen 字段（默认 = cover.length） */
  frameLen?: number;
  /** 覆盖 image1Len 字段（默认 = cover.length） */
  image1Len?: number;
  /** 故意写坏 CRC */
  corruptCrc?: boolean;
}

export interface BuiltNcm {
  file: Uint8Array;
  /** 期望的明文音频（逐字节）。 */
  audio: Uint8Array;
  contentKey: Uint8Array;
  /** audio 在文件内的起始偏移。 */
  audioOffset: number;
  /** metadata 密文在文件内的起始偏移与长度（用于故意破坏）。 */
  metaOffset: number;
  metaLen: number;
  /** CRC 字段起始偏移。 */
  crcOffset: number;
  keyStream: Uint8Array;
}

/**
 * 构造一个结构完整、可被 `parseNcm` 正确解析的 NCM。
 * 版本字节固定 `1, 1`（3.x 容错项由 options 单独制造）。
 */
export function buildNcm(options: BuildNcmOptions = {}): BuiltNcm {
  const audio = options.audio ?? makeFakeAudio();
  const contentKey = options.contentKey ?? TEST_CONTENT_KEY;

  const encContent = aes128EcbEncryptPkcs7(
    concatBytes(latin1Encode('neteasecloudmusic'), contentKey),
    NCM_CONTENT_KEY,
  );
  const xoredContent = encContent.map((b) => b ^ 0x64);

  let encMeta = new Uint8Array(0);
  if (options.meta !== null) {
    const json =
      'music:' +
      JSON.stringify(
        options.meta ?? {
          musicId: 491320,
          musicName: '合成样本曲目',
          artist: [['测试歌手', 15105]],
          album: '合成样本专辑',
          format: 'flac',
          bitrate: 999000,
          duration: 123456,
        },
      );
    const encRaw = aes128EcbEncryptPkcs7(new TextEncoder().encode(json), NCM_METADATA_KEY);
    const text = "163 key(Don't modify):" + base64Encode(encRaw);
    encMeta = latin1Encode(text).map((b) => b ^ 0x63);
  }

  const header = concatBytes(
    latin1Encode('CTENFDAM'),
    Uint8Array.from([1, 1]),
    u32le(xoredContent.length),
    xoredContent,
    u32le(encMeta.length),
    encMeta,
  );

  const metaOffset = header.length - encMeta.length;
  const crcValue = crc32(header) ^ (options.corruptCrc ? 0xff : 0);
  const crc = u32le(crcValue >>> 0);

  const cover = options.cover ?? null;
  const frameLen = options.frameLen ?? (cover ? cover.length : 0);
  const image1Len = options.image1Len ?? (cover ? cover.length : 0);
  const coverHeader = concatBytes(
    Uint8Array.from([options.coverVersion ?? 1]),
    u32le(frameLen),
    u32le(image1Len),
  );

  const keyStream = buildNcmKeyStream(contentKey);
  const encAudio = audio.map((b, i) => b ^ keyStream[i & 0xff]);

  const file = concatBytes(header, crc, coverHeader, cover ?? new Uint8Array(0), encAudio);
  return {
    file,
    audio,
    contentKey,
    audioOffset: header.length + 4 + 9 + frameLen,
    metaOffset,
    metaLen: encMeta.length,
    crcOffset: header.length,
    keyStream,
  };
}

/** MusicEx 尾部（0xC0 字节）：struct[0xB0] + LE payloadLen(0xC0) + LE version + "musicex\0"。 */
export function buildMusicExTail(
  mid: string,
  mediaFilename: string,
  version = 1,
  payloadLen = 0xc0,
): Uint8Array {
  const struct = new Uint8Array(0xb0);
  struct.set(utf16leAscii(mid, 60), 12);
  struct.set(utf16leAscii(mediaFilename, 100), 72);
  const trailer = concatBytes(u32le(payloadLen), u32le(version));
  return concatBytes(struct, trailer, latin1Encode('musicex\0'));
}

/** STag 尾部：CSV(resourceId,2,mediaMid) + BE u32 payloadLen + "STag"。 */
export function buildSTagTail(resourceId = '5177785', mediaMid = '001y7CaR29k6YP'): Uint8Array {
  const csv = latin1Encode(`${resourceId},2,${mediaMid}`);
  return concatBytes(csv, u32be(csv.length), latin1Encode('STag'));
}

/** QTag 尾部：CSV(ekey,resourceId,2) + BE u32 payloadLen + "QTag"。 */
export function buildQTagTail(ekey: string, resourceId = '326454301'): Uint8Array {
  const csv = latin1Encode(`${ekey},${resourceId},2`);
  return concatBytes(csv, u32be(csv.length), latin1Encode('QTag'));
}

/** PCv1Legacy 尾部：ekey(NUL 补齐到 payloadLen) + LE u32 payloadLen。 */
export function buildPcV1Tail(ekey: string, payloadLen = 0x2c0): Uint8Array {
  const payload = new Uint8Array(payloadLen);
  payload.set(latin1Encode(ekey), 0);
  return concatBytes(payload, u32le(payloadLen));
}

/**
 * 按 v1 布局自造 ekey：`base64(header[8] || tc_tea_cbc(key, interleave(SIMPLE_KEY, header)))`。
 * 用于构造任意长度、任意内容的长密钥（覆盖 Map / RC4 两条路径）。
 */
export function makeEkeyV1(
  plainKey: Uint8Array,
  header = Uint8Array.from([0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87]),
): string {
  const teaKey = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    teaKey[2 * i] = EKEY_SIMPLE_KEY[i];
    teaKey[2 * i + 1] = header[i];
  }
  const cipher = tcTeaCbcEncrypt(plainKey, teaKey);
  return base64Encode(concatBytes(header, cipher));
}

/** 按 v2 布局自造 ekey：内层 v1 字符串 → 两层 tc_tea → base64 → 加 EncV2 前缀。 */
export function makeEkeyV2(innerV1: string, prefix = EKEY_V2_PREFIX): string {
  const inner = latin1Encode(innerV1);
  const paddedLen = Math.max(16, Math.ceil((inner.length + 1) / 8) * 8);
  const p2 = new Uint8Array(paddedLen);
  p2.set(inner, 0);
  const p1 = tcTeaCbcEncrypt(p2, EKEY_V2_KEY2);
  const c1 = tcTeaCbcEncrypt(p1, EKEY_V2_KEY1);
  return prefix + base64Encode(c1);
}
