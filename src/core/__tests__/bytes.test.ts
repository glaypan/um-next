import { describe, expect, it } from 'vitest';
import {
  asciiAt,
  base64Decode,
  base64Encode,
  bytesToHex,
  concatBytes,
  crc32,
  endsWithAscii,
  hexToBytes,
  latin1Decode,
  latin1Encode,
  readU32BE,
  readU32LE,
  startsWithAscii,
  trimAtFirstZero,
  utf16leAsciiDecode,
  utf8Decode,
  writeU32BE,
  writeU32LE,
} from '../bytes';

describe('bytes: u32 读写', () => {
  it('readU32LE 能读出大于 2^31 的无符号值', () => {
    const buf = Uint8Array.from([0xef, 0xbe, 0xad, 0xde]);
    expect(readU32LE(buf, 0), '0xdeadbeef 应读成 3735928559 而不是负数').toBe(0xdeadbeef);
  });

  it('writeU32LE 与 readU32LE 往返一致', () => {
    const buf = new Uint8Array(4);
    writeU32LE(buf, 0, 0x8912abcd);
    expect(bytesToHex(buf)).toBe('cdab1289');
    expect(readU32LE(buf, 0)).toBe(0x8912abcd);
  });

  it('writeU32BE 与 readU32BE 往返一致（大端序不混）', () => {
    const buf = new Uint8Array(4);
    writeU32BE(buf, 0, 0xdeadbeef);
    expect(bytesToHex(buf), '大端写入应为 de ad be ef').toBe('deadbeef');
    expect(readU32BE(buf, 0)).toBe(0xdeadbeef);
  });

  it('支持非 0 起始 offset', () => {
    const buf = new Uint8Array(8);
    writeU32LE(buf, 4, 0x01020304);
    expect(bytesToHex(buf)).toBe('0000000004030201');
    expect(readU32LE(buf, 4)).toBe(0x01020304);
  });
});

describe('bytes: 拼接与字符串', () => {
  it('concatBytes 拼接空片段时长度不变', () => {
    const out = concatBytes(new Uint8Array(0), Uint8Array.from([1, 2]), new Uint8Array(0));
    expect(Array.from(out)).toEqual([1, 2]);
  });

  it('latin1 编解码能保住 0x00-0xFF 全部字节', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(bytesToHex(latin1Encode(latin1Decode(all)))).toBe(bytesToHex(all));
  });

  it('utf8Decode 对非法序列返回替换字符而不抛错', () => {
    const bad = Uint8Array.from([0xff, 0xfe, 0x41]);
    expect(() => utf8Decode(bad)).not.toThrow();
    expect(utf8Decode(bad).endsWith('A')).toBe(true);
  });

  it('utf16leAsciiDecode 遇到 NUL 立即停止', () => {
    // "AB" + NUL + "CD"
    const buf = Uint8Array.from([0x41, 0x00, 0x42, 0x00, 0x00, 0x00, 0x43, 0x00]);
    expect(utf16leAsciiDecode(buf)).toBe('AB');
  });

  it('utf16leAsciiDecode 高字节非 0 时停止（非 ASCII 视作结束）', () => {
    const buf = Uint8Array.from([0x41, 0x00, 0x42, 0x4e]);
    expect(utf16leAsciiDecode(buf)).toBe('A');
  });

  it('trimAtFirstZero 在无 0 时原样返回全部字节', () => {
    const buf = Uint8Array.from([1, 2, 3]);
    expect(bytesToHex(trimAtFirstZero(buf))).toBe('010203');
  });

  it('trimAtFirstZero 截断到第一个 0x00 之前', () => {
    expect(bytesToHex(trimAtFirstZero(Uint8Array.from([9, 8, 0, 7])))).toBe('0908');
  });
});

describe('bytes: base64', () => {
  it('base64Decode 允许省略 padding', () => {
    expect(latin1Decode(base64Decode('aGVsbG8gd29ybGQ'))).toBe('hello world');
  });

  it('base64 编解码往返（含 1/2 字节余数）', () => {
    for (const text of ['a', 'ab', 'abc', 'hello world']) {
      const bytes = latin1Encode(text);
      expect(base64Encode(bytes)).toMatch(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
      expect(latin1Decode(base64Decode(base64Encode(bytes)))).toBe(text);
    }
  });

  it('base64Decode 遇到字母表外字符抛错', () => {
    expect(() => base64Decode('abc$def')).toThrow(/非法字符/);
  });

  it('base64Decode 遇到长度为 4n+1 时抛错', () => {
    expect(() => base64Decode('abcde')).toThrow(/长度非法/);
  });
});

describe('bytes: CRC-32 / hex / 魔数', () => {
  it('crc32("123456789") 等于 zlib 标准值 0xcbf43926', () => {
    expect(crc32(latin1Encode('123456789'))).toBe(0xcbf43926);
  });

  it('crc32 支持区间参数（只算子区间）', () => {
    const all = concatBytes(latin1Encode('XXX'), latin1Encode('123456789'));
    expect(crc32(all, 3, all.length)).toBe(0xcbf43926);
  });

  it('hexToBytes / bytesToHex 往返一致且忽略分隔符', () => {
    expect(bytesToHex(hexToBytes('DE:AD be ef'))).toBe('deadbeef');
  });

  it('hexToBytes 拒绝奇数长度', () => {
    expect(() => hexToBytes('abc')).toThrow(/偶数/);
  });

  it('startsWithAscii / endsWithAscii / asciiAt 定位正确', () => {
    const buf = latin1Encode('CTENFDAM\u0000x');
    expect(startsWithAscii(buf, 'CTENFDAM')).toBe(true);
    expect(startsWithAscii(buf, 'CTENFDAX')).toBe(false);
    expect(endsWithAscii(buf, '\u0000x')).toBe(true);
    expect(asciiAt(buf, 0, 8)).toBe('CTENFDAM');
    // asciiAt 遇 0 停止
    expect(asciiAt(buf, 8, 2)).toBe('');
  });
});
