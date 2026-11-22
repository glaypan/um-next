/**
 * 字节与编码工具。
 *
 * 约定（与上游 Rust 实现保持一致）：
 *  - 所有多字节整数都显式区分 LE / BE，禁止使用隐式平台序。
 *  - base64 使用标准字母表 `A-Za-z0-9+/`，解码时 padding 可有可无。
 *  - CRC-32 使用 zlib / ISO-HDLC（poly 0xEDB88320，反射），不是 CRC-32C。
 */

/** 读取小端 u32。调用方需保证 offset + 4 <= 长度。 */
export function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0
  );
}

/** 读取大端 u32。调用方需保证 offset + 4 <= 长度。 */
export function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
  );
}

/** 写入小端 u32。 */
export function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

/** 写入大端 u32。 */
export function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/** 顺序拼接多段字节。 */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** latin1（每字符一个字节）解码，用于承载任意二进制/ASCII 字符串。 */
export function latin1Decode(buf: Uint8Array): string {
  let out = '';
  // 分块避免超长字符串拼接开销抖动
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    out += String.fromCharCode(...buf.subarray(i, Math.min(i + chunk, buf.length)));
  }
  return out;
}

/** latin1 编码（每个码位截断到低 8 位）。 */
export function latin1Encode(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/** UTF-8 解码（非法序列用替换字符，不抛异常）。 */
export function utf8Decode(buf: Uint8Array): string {
  return new TextDecoder('utf-8').decode(buf);
}

/**
 * 解码「UTF-16LE 存储但内容只含 ASCII」的定长字符串（MusicEx 的 mid / media_filename）。
 * 遇到 NUL、非 ASCII 低字节、或高字节非 0 立即停止。
 */
export function utf16leAsciiDecode(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i];
    const hi = buf[i + 1];
    if (lo === 0 || lo > 0x7f || hi !== 0) break;
    out += String.fromCharCode(lo);
  }
  return out;
}

/** 截断到第一个 0x00 之前。 */
export function trimAtFirstZero(buf: Uint8Array): Uint8Array {
  const idx = buf.indexOf(0);
  return idx < 0 ? buf : buf.subarray(0, idx);
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/**
 * 标准 base64 解码。padding 可有可无；`=` 只允许出现在尾部（多余部分被忽略）。
 * 遇到字母表以外的字符抛错——QMC 的 ekey 都是干净字符串，出现非法字符一定是输入错误。
 */
export function base64Decode(input: string): Uint8Array {
  let end = input.length;
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) === 0x3d /* '=' */) {
      end = i;
      break;
    }
  }
  const body = input.slice(0, end).replace(/[\s]/g, '');
  if (body.length % 4 === 1) throw new Error('base64 长度非法');
  const outLen = Math.floor((body.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let pos = 0;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    const v = code < 128 ? B64_LOOKUP[code] : -1;
    if (v < 0) throw new Error('base64 含非法字符');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/** 标准 base64 编码（带 `=` padding）。 */
export function base64Encode(buf: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < buf.length; i += 3) {
    const n = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
    out +=
      B64_ALPHABET[(n >>> 18) & 0x3f] +
      B64_ALPHABET[(n >>> 12) & 0x3f] +
      B64_ALPHABET[(n >>> 6) & 0x3f] +
      B64_ALPHABET[n & 0x3f];
  }
  const rest = buf.length - i;
  if (rest === 1) {
    const n = buf[i] << 16;
    out += B64_ALPHABET[(n >>> 18) & 0x3f] + B64_ALPHABET[(n >>> 12) & 0x3f] + '==';
  } else if (rest === 2) {
    const n = (buf[i] << 16) | (buf[i + 1] << 8);
    out +=
      B64_ALPHABET[(n >>> 18) & 0x3f] +
      B64_ALPHABET[(n >>> 12) & 0x3f] +
      B64_ALPHABET[(n >>> 6) & 0x3f] +
      '=';
  }
  return out;
}

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 / ISO-HDLC（zlib 同款）。范围 [start, end)。 */
export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 十六进制字符串 → 字节。 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[\s:]/g, '');
  if (clean.length % 2 !== 0) throw new Error('hex 长度必须为偶数');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('hex 含非法字符');
    out[i] = byte;
  }
  return out;
}

/** 字节 → 十六进制字符串（小写，无分隔）。 */
export function bytesToHex(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

/** 字节序列是否以指定 ASCII 字符串结尾。 */
export function endsWithAscii(buf: Uint8Array, suffix: string, endOffset = buf.length): boolean {
  if (endOffset < suffix.length) return false;
  const start = endOffset - suffix.length;
  for (let i = 0; i < suffix.length; i++) {
    if (buf[start + i] !== suffix.charCodeAt(i)) return false;
  }
  return true;
}

/** 字节序列是否以指定 ASCII 字符串开头。 */
export function startsWithAscii(buf: Uint8Array, prefix: string): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/** 从字节序列的指定位置起读取 ASCII 字符串（遇到 0x00 或长度上限停止）。 */
export function asciiAt(buf: Uint8Array, offset: number, length: number): string {
  const end = Math.min(offset + length, buf.length);
  let out = '';
  for (let i = offset; i < end; i++) {
    if (buf[i] === 0) break;
    out += String.fromCharCode(buf[i]);
  }
  return out;
}
