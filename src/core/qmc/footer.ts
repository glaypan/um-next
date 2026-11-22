/**
 * QMC 尾部解析（4 种，识别顺序固定：STag → QTag → MusicEx → PCv1Legacy）。
 *
 * 各自的 `size` 语义不同，切勿混用：
 *  - STag / QTag：payloadLen + 8
 *  - MusicEx    ：固定 0xC0
 *  - PCv1Legacy ：payloadLen + 4
 *
 * 输入应该是「文件末尾若干字节」（本仓库统一取最后 4096 字节），解析失败一律返回 null，
 * 绝不抛异常——尾部解析是识别链的一环，误判比漏判危险得多。
 */
import {
  endsWithAscii,
  latin1Decode,
  readU32BE,
  readU32LE,
  trimAtFirstZero,
  utf16leAsciiDecode,
} from '../bytes';

export type QmcFooter =
  | { kind: 'stag'; size: number; resourceId: string; mediaMid: string }
  | { kind: 'qtag'; size: number; ekey: string; resourceId: string }
  | { kind: 'musicex'; size: number; mid: string; mediaFilename: string }
  | { kind: 'pcv1'; size: number; ekey: string };

/** MusicEx 尾部总长：struct 0xB0 + payloadLen(4) + version(4) + "musicex\0"(8)。 */
export const MUSICEX_TOTAL_SIZE = 0xc0;
/** MusicEx 结构体部分长度。 */
export const MUSICEX_STRUCT_SIZE = 0xb0;
/** PCv1Legacy 允许的最大 ekey 段长度。 */
export const PCV1_MAX_EKEY_LEN = 0x500;

const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

/** Android STag：CSV = `resourceId,2,mediaMid`，不含 ekey。 */
function parseSTag(tail: Uint8Array): QmcFooter | null {
  if (tail.length < 8 || !endsWithAscii(tail, 'STag')) return null;
  const area = tail.subarray(0, tail.length - 4);
  if (area.length < 4) return null;
  const payloadLen = readU32BE(area, area.length - 4);
  if (payloadLen <= 0 || payloadLen > area.length - 4) return null;
  const csv = latin1Decode(area.subarray(area.length - 4 - payloadLen, area.length - 4));
  const parts = csv.split(',');
  if (parts.length !== 3) return null;
  const [resourceId, version, mediaMid] = parts;
  if (version !== '2') return null;
  if (!/^[0-9]+$/.test(resourceId)) return null;
  if (mediaMid.length === 0) return null;
  return { kind: 'stag', size: payloadLen + 8, resourceId, mediaMid };
}

/** Android QTag：CSV = `ekey,resourceId,2`，含 ekey。 */
function parseQTag(tail: Uint8Array): QmcFooter | null {
  if (tail.length < 8 || !endsWithAscii(tail, 'QTag')) return null;
  const area = tail.subarray(0, tail.length - 4);
  if (area.length < 4) return null;
  const payloadLen = readU32BE(area, area.length - 4);
  if (payloadLen <= 0 || payloadLen > area.length - 4) return null;
  const csv = latin1Decode(area.subarray(area.length - 4 - payloadLen, area.length - 4));
  const parts = csv.split(',');
  if (parts.length !== 3) return null;
  const [ekey, resourceId, version] = parts;
  if (version !== '2') return null;
  if (!/^[0-9]+$/.test(resourceId)) return null;
  if (!BASE64_RE.test(ekey)) return null;
  return { kind: 'qtag', size: payloadLen + 8, ekey, resourceId };
}

/** PC ≥ 19.57 MusicEx：结构 0xB0 + LE payloadLen(=0xC0) + LE version(=1) + "musicex\0"。 */
function parseMusicEx(tail: Uint8Array): QmcFooter | null {
  if (tail.length < MUSICEX_TOTAL_SIZE || !endsWithAscii(tail, 'musicex\0')) return null;
  const withoutMagic = tail.subarray(0, tail.length - 8);
  const version = readU32LE(withoutMagic, withoutMagic.length - 4);
  if (version !== 1) return null;
  const withoutVersion = withoutMagic.subarray(0, withoutMagic.length - 4);
  const payloadLen = readU32LE(withoutVersion, withoutVersion.length - 4);
  if (payloadLen !== MUSICEX_TOTAL_SIZE) return null;
  const structStart = withoutVersion.length - 4 - MUSICEX_STRUCT_SIZE;
  if (structStart < 0) return null;
  const struct = withoutVersion.subarray(structStart, withoutVersion.length - 4);
  // 布局：u32 * 3 | mid[60] | mediaFilename[100] | u32
  const mid = utf16leAsciiDecode(struct.subarray(12, 12 + 60));
  const mediaFilename = utf16leAsciiDecode(struct.subarray(72, 72 + 100));
  return { kind: 'musicex', size: MUSICEX_TOTAL_SIZE, mid, mediaFilename };
}

/** PC 旧版：`ekey(≤payloadLen, NUL 补齐) + LE u32 payloadLen`。 */
function parsePcV1Legacy(tail: Uint8Array): QmcFooter | null {
  if (tail.length < 8) return null;
  const payloadLen = readU32LE(tail, tail.length - 4);
  // 超长视为「不是本类型」而不是「文件损坏」——上游 wasm 层也把它转成 null
  if (payloadLen < 16 || payloadLen > PCV1_MAX_EKEY_LEN) return null;
  if (payloadLen + 4 > tail.length) return null;
  const raw = trimAtFirstZero(tail.subarray(tail.length - 4 - payloadLen, tail.length - 4));
  const ekey = latin1Decode(raw);
  if (!BASE64_RE.test(ekey)) return null;
  return { kind: 'pcv1', size: payloadLen + 4, ekey };
}

/** 统一入口。`tail` 建议为文件最后 4096 字节（不足则整文件）。 */
export function parseQmcFooter(tail: Uint8Array): QmcFooter | null {
  return parseSTag(tail) ?? parseQTag(tail) ?? parseMusicEx(tail) ?? parsePcV1Legacy(tail) ?? null;
}
