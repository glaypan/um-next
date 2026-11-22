/**
 * ekey 解析：QMC2 的「密钥字符串」→ 真正的长密钥字节。
 *
 * v1：`base64( header[8] || tc_tea_cbc(cipher) )`，TEA 密钥 = interleave(SIMPLE_KEY, header)。
 * v2：字符串前缀 `UVFNdXNpYyBFbmNWMixLZXk6`（= base64("QQMusic EncV2,Key:")），
 *     base64 解码后连续两次 tc_tea 解密（先 KEY1 后 KEY2），截断到首个 0x00，
 *     得到的内层又是一个 **v1** ekey 字符串。
 *
 * 最易错的一点：返回的密钥**包含那 8 字节 header**。漏掉它会导致长度判据（300）
 * 与 Map/RC4 选路全部错位。
 */
import { base64Decode, concatBytes, latin1Decode, trimAtFirstZero } from '../bytes';
import { tcTeaCbcDecrypt } from '../tea';

/** base64("QQMusic EncV2,Key:")。 */
export const EKEY_V2_PREFIX = 'UVFNdXNpYyBFbmNWMixLZXk6';
/** 用户在 PC 端看到的明文前缀，等价于上面的 base64 形式。 */
export const EKEY_V2_PLAIN_PREFIX = 'QQMusic EncV2,Key:';

export const EKEY_V2_KEY1 = Uint8Array.from([
  0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40, 0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28,
]);
export const EKEY_V2_KEY2 = Uint8Array.from([
  0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54,
]);

/**
 * `EKEY_SIMPLE_KEY[i] = trunc(min(255, |tan(106 + i*0.1)| * 100))`
 * 结果固定为 69 56 46 38 2B 20 15 0B。
 */
export const EKEY_SIMPLE_KEY: Uint8Array = (() => {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    const value = Math.trunc(Math.min(255, Math.abs(Math.tan(106 + i * 0.1)) * 100));
    out[i] = value & 0xff;
  }
  return out;
})();

/** 把明文前缀形式（`QQMusic EncV2,Key:`）归一化为 base64 前缀形式。 */
export function normalizeEkey(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (trimmed.startsWith(EKEY_V2_PLAIN_PREFIX)) {
    return EKEY_V2_PREFIX + trimmed.slice(EKEY_V2_PLAIN_PREFIX.length);
  }
  return trimmed;
}

/** v1 ekey → 长密钥（8 字节 header + TEA 明文）。 */
export function decryptEkeyV1(ekey: string): Uint8Array {
  if (ekey.length < 12) throw new Error('ekey 长度过短');
  const raw = base64Decode(ekey);
  if (raw.length < 16) throw new Error('ekey 解码后长度不足');
  const header = raw.subarray(0, 8);
  const cipher = raw.subarray(8);
  const teaKey = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    teaKey[2 * i] = EKEY_SIMPLE_KEY[i];
    teaKey[2 * i + 1] = header[i];
  }
  const plain = tcTeaCbcDecrypt(cipher, teaKey);
  return concatBytes(header, plain);
}

/** 任意版本 ekey → 长密钥。 */
export function decryptEkey(rawEkey: string): Uint8Array {
  const ekey = normalizeEkey(rawEkey);
  if (ekey.startsWith(EKEY_V2_PREFIX)) {
    const rest = ekey.slice(EKEY_V2_PREFIX.length);
    let buf = tcTeaCbcDecrypt(base64Decode(rest), EKEY_V2_KEY1);
    buf = tcTeaCbcDecrypt(buf, EKEY_V2_KEY2);
    const inner = latin1Decode(trimAtFirstZero(buf));
    return decryptEkeyV1(inner);
  }
  return decryptEkeyV1(ekey);
}
