import { describe, expect, it } from 'vitest';
import {
  EKEY_SIMPLE_KEY,
  EKEY_V2_PLAIN_PREFIX,
  EKEY_V2_PREFIX,
  decryptEkey,
  decryptEkeyV1,
  normalizeEkey,
} from '../qmc/ekey';
import { base64Encode, bytesToHex, latin1Encode, latin1Decode } from '../bytes';
import { makeEkeyV1, makeEkeyV2 } from './helpers/build';

/** 上游 ekey v1 向量（解出 39 字节 key → QMC2 Map 路径）。 */
const EKEY_V1 =
  'MTIzNDU2NzhN2csrbjHfIPH0BrVByijvtaAXJdb4Iy7P/ktYG6Wxly+Vz5sZ5nqDPUHoVBuuzSQ=';
/** 同一把密钥的 EncV2 形式。 */
const EKEY_V2 =
  'UVFNdXNpYyBFbmNWMixLZXk6d/S8i//PVeRowyovUFz1jJ+6VbOYnLZj1Mp5JLj2rEfhiMvu1tfCQoqMDhvElejO55orRpPw46vw568GCNAPOggejJzfgaK9TXJ9LEbK4KvQh8T7d6nBhelG8gIgpP9g1Cm8y4mPemQ=';
const EXPECTED_KEY_HEX =
  '3132333435363738716d63322d6d61702d6b65792d6d6174657269616c2d333262797465732121';

/** 按 v1 布局自造 ekey（实现见 helpers/build.ts，与生产解密严格对称）。 */

describe('ekey: 常量', () => {
  it('EKEY_SIMPLE_KEY 等于 tan 公式固定的 8 字节', () => {
    expect(bytesToHex(EKEY_SIMPLE_KEY)).toBe('695646382b20150b');
  });

  it('EncV2 前缀常量自洽：base64("QQMusic EncV2,Key:") === EKEY_V2_PREFIX', () => {
    expect(base64Encode(latin1Encode(EKEY_V2_PLAIN_PREFIX))).toBe(EKEY_V2_PREFIX);
  });
});

describe('ekey: 上游向量', () => {
  it('v1 向量解出 39 字节 key', () => {
    const key = decryptEkey(EKEY_V1);
    expect(bytesToHex(key)).toBe(EXPECTED_KEY_HEX);
    expect(key.length, '39 字节 → 走 QMC2 Map 路径').toBe(39);
  });

  it('v2 向量（连续两次 tc_tea）解出同一把 key', () => {
    expect(bytesToHex(decryptEkey(EKEY_V2))).toBe(EXPECTED_KEY_HEX);
  });

  it('解出的 key 含 8 字节 header（长度 39 = 8 + 31 字节原始密钥）', () => {
    expect(latin1Decode(decryptEkey(EKEY_V1).subarray(0, 8))).toBe('12345678');
  });
});

describe('ekey: v1 自造往返', () => {
  for (const len of [16, 64, 300]) {
    it(`key 长度 ${len} 的 v1 ekey 可解回原 key`, () => {
      const plainKey = new Uint8Array(len);
      for (let i = 0; i < len; i++) plainKey[i] = (i * 7 + 1) & 0xff;
      const ekey = makeEkeyV1(plainKey);
      const out = decryptEkeyV1(ekey);
      expect(out.length, '返回值包含 8 字节 header').toBe(len + 8);
      expect(bytesToHex(out.subarray(8))).toBe(bytesToHex(plainKey));
    });
  }

  it('不同 header 生成不同 ekey，但解出的密钥相同', () => {
    const plainKey = latin1Encode('0123456789abcdef');
    const a = makeEkeyV1(plainKey, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const b = makeEkeyV1(plainKey, Uint8Array.from([9, 10, 11, 12, 13, 14, 15, 16]));
    expect(a).not.toBe(b);
    expect(bytesToHex(decryptEkey(a).subarray(8))).toBe(bytesToHex(plainKey));
    expect(bytesToHex(decryptEkey(b).subarray(8))).toBe(bytesToHex(plainKey));
  });
});

describe('ekey: v2 自造往返与前缀归一化', () => {
  const plainKey = latin1Encode('qmc2-v2-roundtrip-key-material');
  const innerV1 = makeEkeyV1(plainKey);

  it('base64 前缀形式可解出原 key', () => {
    const key = decryptEkey(makeEkeyV2(innerV1));
    expect(bytesToHex(key.subarray(8))).toBe(bytesToHex(plainKey));
  });

  it('明文前缀 QQMusic EncV2,Key: 与 base64 前缀等价', () => {
    const asBase64 = makeEkeyV2(innerV1);
    const asPlain = makeEkeyV2(innerV1, EKEY_V2_PLAIN_PREFIX);
    expect(asPlain).not.toBe(asBase64);
    expect(bytesToHex(decryptEkey(asPlain))).toBe(bytesToHex(decryptEkey(asBase64)));
  });

  it('normalizeEkey 去掉首尾空白与引号', () => {
    expect(normalizeEkey(`  "${EKEY_V1}"  `)).toBe(EKEY_V1);
    expect(normalizeEkey(`'${EKEY_V1}'`)).toBe(EKEY_V1);
  });

  it('normalizeEkey 把明文前缀改写成 base64 前缀', () => {
    const plain = `${EKEY_V2_PLAIN_PREFIX}AAAA`;
    expect(normalizeEkey(plain)).toBe(`${EKEY_V2_PREFIX}AAAA`);
  });
});

describe('ekey: 错误输入', () => {
  it('非 base64 字符抛错', () => {
    expect(() => decryptEkey('这不是ekey')).toThrow();
  });

  it('长度过短抛明确错误', () => {
    expect(() => decryptEkey('abc')).toThrow(/过短/);
  });

  it('base64 合法但解码后不足 16 字节抛错', () => {
    // 'AAAA' → 3 字节
    expect(() => decryptEkeyV1('AAAAAAAAAAAA')).toThrow(/长度不足/);
  });

  it('v2 前缀后跟垃圾数据不会静默成功', () => {
    expect(() => decryptEkey(`${EKEY_V2_PREFIX}AAAA`)).toThrow();
  });
});
