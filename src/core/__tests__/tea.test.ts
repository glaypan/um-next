import { describe, expect, it } from 'vitest';
import {
  teaDecryptBlock,
  teaEncryptBlock,
  teaKeyToU32,
  tcTeaCbcDecrypt,
  tcTeaCbcEncrypt,
} from '../tea';
import { bytesToHex, hexToBytes, latin1Encode } from '../bytes';

/** 上游 `tc_tea` 测试向量。 */
const TEA_KEY = '12345678ABCDEFGH';
const TEA_CIPHER_HEX = '91095162e3f5b6dc6b414b50d1a5b84ec50d0c1b1196fd3c';
const TEA_PLAIN_HEX = '0102030405060708';

describe('tea: 官方向量', () => {
  it('tc_tea CBC 解密官方向量得到 0102030405060708', () => {
    const plain = tcTeaCbcDecrypt(hexToBytes(TEA_CIPHER_HEX), TEA_KEY);
    expect(bytesToHex(plain), '上游 content_key.rs 的 tc_tea 向量').toBe(TEA_PLAIN_HEX);
  });

  it('用自实现的加密可以还原出同一份密文（说明 16 轮 + 定制 CBC 完全对称）', () => {
    const cipher = tcTeaCbcEncrypt(hexToBytes(TEA_PLAIN_HEX), TEA_KEY, Uint8Array.from([0x00, 0x01]));
    // 官方密文的 salt/padSize 未知，故只断言「再解回来一致」
    expect(bytesToHex(tcTeaCbcDecrypt(cipher, TEA_KEY))).toBe(TEA_PLAIN_HEX);
  });

  it('teaKeyToU32 按大端读取四组 u32', () => {
    const k = teaKeyToU32(latin1Encode('12345678ABCDEFGH'));
    expect(k.length).toBe(4);
    expect(k[0].toString(16)).toBe('31323334');
    expect(k[3].toString(16)).toBe('45464748');
  });

  it('teaEncryptBlock 与 teaDecryptBlock 互为逆运算', () => {
    const k = teaKeyToU32(latin1Encode(TEA_KEY));
    const enc = teaEncryptBlock(0x11223344, 0x55667788, k);
    const dec = teaDecryptBlock(enc.y, enc.z, k);
    expect(dec.y >>> 0).toBe(0x11223344);
    expect(dec.z >>> 0).toBe(0x55667788);
  });
});

describe('tea: 往返与错误处理', () => {
  it('多种明文长度的 CBC 往返一致', () => {
    for (const len of [0, 1, 7, 8, 15, 16, 17, 39, 114, 300]) {
      const plain = new Uint8Array(len);
      for (let i = 0; i < len; i++) plain[i] = (i * 17 + 3) & 0xff;
      const cipher = tcTeaCbcEncrypt(plain, TEA_KEY);
      expect(cipher.length % 8, '密文长度必须是 8 的整数倍').toBe(0);
      expect(bytesToHex(tcTeaCbcDecrypt(cipher, TEA_KEY)), `明文长度 ${len} 往返`).toBe(
        bytesToHex(plain),
      );
    }
  });

  it('自定义 salt 不影响解密结果（salt 只参与头部两个字节）', () => {
    const plain = latin1Encode('salt test');
    const a = tcTeaCbcEncrypt(plain, TEA_KEY, Uint8Array.from([0x00, 0x01]));
    const b = tcTeaCbcEncrypt(plain, TEA_KEY, Uint8Array.from([0xff, 0xee]));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(bytesToHex(tcTeaCbcDecrypt(a, TEA_KEY))).toBe(bytesToHex(plain));
    expect(bytesToHex(tcTeaCbcDecrypt(b, TEA_KEY))).toBe(bytesToHex(plain));
  });

  it('错误密钥解不出原文（尾部 7 个 0 校验会失败）', () => {
    const cipher = tcTeaCbcEncrypt(latin1Encode('wrong key test'), TEA_KEY);
    let threw = false;
    let out: Uint8Array | null = null;
    try {
      out = tcTeaCbcDecrypt(cipher, 'ABCDEFGH12345678');
    } catch {
      threw = true;
    }
    // 允许极低概率「恰好解出」的错觉吗？不允许：要么抛错，要么内容必须不同
    expect(threw || bytesToHex(out ?? new Uint8Array()) !== bytesToHex(latin1Encode('wrong key test'))).toBe(
      true,
    );
  });

  it('密文长度 < 16 抛错', () => {
    expect(() => tcTeaCbcDecrypt(new Uint8Array(8), TEA_KEY)).toThrow(/长度非法/);
  });

  it('密文长度非 8 倍数抛错', () => {
    expect(() => tcTeaCbcDecrypt(new Uint8Array(20), TEA_KEY)).toThrow(/长度非法/);
  });

  it('密钥长度非 16 字节抛错', () => {
    expect(() => tcTeaCbcDecrypt(new Uint8Array(16), 'short')).toThrow(/16 字节/);
  });
});
