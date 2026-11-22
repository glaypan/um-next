import { describe, expect, it } from 'vitest';
import {
  aes128DecryptBlock,
  aes128EcbDecryptPkcs7,
  aes128EcbEncryptPkcs7,
  aes128EncryptBlock,
  aes128ExpandKey,
} from '../aes128';
import { bytesToHex, hexToBytes, latin1Encode, latin1Decode } from '../bytes';

const FIPS_KEY = hexToBytes('000102030405060708090a0b0c0d0e0f');
const FIPS_PLAIN = hexToBytes('00112233445566778899aabbccddeeff');
const FIPS_CIPHER = '69c4e0d86a7b0430d8cdb78070b4c55a';

describe('aes128: FIPS-197 官方向量', () => {
  it('密钥扩展首尾两个字等于原密钥（AES-128 不做 w[0..3] 变换）', () => {
    const rk = aes128ExpandKey(FIPS_KEY);
    expect(rk.length, 'AES-128 应是 11 组 × 16 字节 = 176 字节').toBe(176);
    expect(bytesToHex(rk.subarray(0, 16))).toBe(bytesToHex(FIPS_KEY));
  });

  it('加密单个分组得到 FIPS-197 附录 C 的期望密文', () => {
    const out = aes128EncryptBlock(FIPS_PLAIN, aes128ExpandKey(FIPS_KEY));
    expect(bytesToHex(out), 'FIPS-197 C.1 单分组加密').toBe(FIPS_CIPHER);
  });

  it('解密单个分组可还原 FIPS-197 明文', () => {
    const out = aes128DecryptBlock(hexToBytes(FIPS_CIPHER), aes128ExpandKey(FIPS_KEY));
    expect(bytesToHex(out)).toBe(bytesToHex(FIPS_PLAIN));
  });

  it('密钥长度非 16 字节时抛明确错误', () => {
    expect(() => aes128ExpandKey(new Uint8Array(15))).toThrow(/16 字节/);
  });
});

describe('aes128: ECB + PKCS#7', () => {
  it('空明文加密后是一个完整分组（PKCS#7 必填 16 字节填充）', () => {
    const enc = aes128EcbEncryptPkcs7(new Uint8Array(0), FIPS_KEY);
    expect(enc.length).toBe(16);
    expect(aes128EcbDecryptPkcs7(enc, FIPS_KEY).length).toBe(0);
  });

  it('长度 16 的整数倍也要补一个整组填充', () => {
    const plain = new Uint8Array(16).fill(0x41);
    const enc = aes128EcbEncryptPkcs7(plain, FIPS_KEY);
    expect(enc.length).toBe(32);
    expect(bytesToHex(aes128EcbDecryptPkcs7(enc, FIPS_KEY))).toBe(bytesToHex(plain));
  });

  it('多种长度加解密往返一致', () => {
    for (const len of [1, 5, 15, 17, 63, 114]) {
      const plain = new Uint8Array(len);
      for (let i = 0; i < len; i++) plain[i] = (i * 13 + 5) & 0xff;
      const back = aes128EcbDecryptPkcs7(aes128EcbEncryptPkcs7(plain, FIPS_KEY), FIPS_KEY);
      expect(bytesToHex(back), `明文长度 ${len} 往返`).toBe(bytesToHex(plain));
    }
  });

  it('key 传字符串时按 latin1 逐字节取（NCM 的密钥就是字符串）', () => {
    const plain = latin1Encode('hzHRAmso5kInbaxW');
    const enc = aes128EcbEncryptPkcs7(plain, 'hzHRAmso5kInbaxW');
    expect(latin1Decode(aes128EcbDecryptPkcs7(enc, 'hzHRAmso5kInbaxW'))).toBe('hzHRAmso5kInbaxW');
  });

  it('密文长度非法（非 16 倍数）时抛错', () => {
    expect(() => aes128EcbDecryptPkcs7(new Uint8Array(17), FIPS_KEY)).toThrow(/长度非法/);
  });

  it('空密文抛错', () => {
    expect(() => aes128EcbDecryptPkcs7(new Uint8Array(0), FIPS_KEY)).toThrow(/长度非法/);
  });

  it('PKCS#7 填充非法时抛错（不能静默返回垃圾数据）', () => {
    // 手工造一个末字节为 0 的分组：pad=0 属于非法填充
    const block = new Uint8Array(16).fill(0x41);
    block[15] = 0x00;
    const enc = aes128EncryptBlock(block, aes128ExpandKey(FIPS_KEY));
    expect(() => aes128EcbDecryptPkcs7(enc, FIPS_KEY)).toThrow(/PKCS#7/);
  });
});
