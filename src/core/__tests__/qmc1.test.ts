import { describe, expect, it } from 'vitest';
import {
  V1_OFFSET_BOUNDARY,
  V1_STATIC_KEY,
  decryptQMC1,
  decryptQMC1Copy,
  decryptQMC1WithKey,
  qmc1Transform,
} from '../qmc/qmc1';
import { bytesToHex, hexToBytes, latin1Decode, latin1Encode } from '../bytes';

/** 自造 key：key[i] = i + 1。 */
const SEQ_KEY = (() => {
  const key = new Uint8Array(128);
  for (let i = 0; i < 128; i++) key[i] = i + 1;
  return key;
})();

describe('qmc1: 上游已知向量', () => {
  it('静态密钥向量 ab2f…02 解出 "hello world"', () => {
    const data = hexToBytes('ab2fbaa6ff47803daacd02');
    decryptQMC1(data, 0);
    expect(latin1Decode(data)).toBe('hello world');
  });

  it('key[i]=i+1 且 offset=0 时 "igohj&pg{fo" 解出 "hello world"', () => {
    const data = latin1Encode('igohj&pg{fo');
    decryptQMC1WithKey(data, 0, SEQ_KEY);
    expect(latin1Decode(data)).toBe('hello world');
  });

  it('offset=0x7FFA 起始（跨越 0x7FFF 边界）仍解出 "hello world"', () => {
    const data = hexToBytes('1319111210a0756c766962');
    decryptQMC1WithKey(data, 0x7ffa, SEQ_KEY);
    expect(latin1Decode(data)).toBe('hello world');
  });
});

describe('qmc1: 偏移边界语义', () => {
  it('offset 恰好等于 0x7FFF 时不取模（上游 test_decode_boundary 专测字节）', () => {
    const idx = V1_OFFSET_BOUNDARY % 128;
    const value = V1_STATIC_KEY[idx] ^ 0x5a;
    const buf = Uint8Array.from([value]);
    decryptQMC1(buf, V1_OFFSET_BOUNDARY);
    expect(buf[0], 'offset=0x7FFF 必须保持原偏移，不能回绕成 0').toBe(0x5a);
  });

  it('offset 超过 0x7FFF 后按 %0x7FFF 回绕（0x8000 等价于 1）', () => {
    expect(qmc1Transform(V1_STATIC_KEY, 0x11, 0x8000)).toBe(0x11 ^ V1_STATIC_KEY[1]);
    expect(qmc1Transform(V1_STATIC_KEY, 0x11, 0x7fff * 2 + 3)).toBe(0x11 ^ V1_STATIC_KEY[3]);
  });

  it('transform 只影响低 8 位（高位被掩掉）', () => {
    expect(qmc1Transform(SEQ_KEY, 0x1ff, 0)).toBe(0xff ^ 0x01);
  });
});

describe('qmc1: 原地/副本语义', () => {
  it('decryptQMC1 原地修改入参', () => {
    const data = hexToBytes('ab2fbaa6ff47803daacd02');
    const before = bytesToHex(data);
    decryptQMC1(data, 0);
    expect(bytesToHex(data)).not.toBe(before);
  });

  it('decryptQMC1Copy 不修改入参（探测用）', () => {
    const data = hexToBytes('ab2fbaa6ff47803daacd02');
    const before = bytesToHex(data);
    const out = decryptQMC1Copy(data, 0);
    expect(bytesToHex(data), '入参必须保持不变').toBe(before);
    expect(latin1Decode(out)).toBe('hello world');
  });

  it('XOR 自反：连续解两次还原原文', () => {
    const data = latin1Encode('fLaC0123456789abcdef');
    const before = bytesToHex(data);
    decryptQMC1(data, 0);
    decryptQMC1(data, 0);
    expect(bytesToHex(data)).toBe(before);
  });

  it('静态密钥长度为 128 字节', () => {
    expect(V1_STATIC_KEY.length).toBe(128);
  });
});
