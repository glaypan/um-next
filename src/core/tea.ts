/**
 * tc_tea：腾讯改版的 TEA 加密（16 轮 + 定制 CBC）。
 *
 * 与标准 TEA 的差异（逐条都在 ekey 解析里被验证）：
 *  - 轮数 **16**（标准是 32 轮）
 *  - delta = 0x9E3779B9，64 位块按 **大端** 读写
 *  - CBC 变体：iv1 = iv2 = 0，且 iv 的更新方式与标准 CBC 不同（详见 decrypt 内注释）
 *  - 明文布局：[0] = (salt[0] & 0xF8) | pad，[1..2] = 盐，随后明文，末尾固定 7 个 0 字节做完整性校验
 *
 * 实现注意：64 位块**不要用 BigInt**（在 Worker 里会慢一个数量级），直接按两个 u32 处理：
 * 块的前 4 字节是 y、后 4 字节是 z；iv1/iv2 也各存一对 u32。
 */
import { readU32BE, writeU32BE } from './bytes';

const DELTA = 0x9e3779b9;
const ROUNDS = 16;

/** TEA 轮函数 f(v, sum, k1, k2)。全部按 u32 环绕。 */
function teaF(v: number, sum: number, k1: number, k2: number): number {
  const left = (((v << 4) >>> 0) + k1) >>> 0;
  const right = ((v >>> 5) + k2) >>> 0;
  const mid = (sum + v) >>> 0;
  return (left ^ mid ^ right) >>> 0;
}

/** 16 字节 key → 4 个大端 u32。 */
export function teaKeyToU32(key: Uint8Array): Uint32Array {
  if (key.length !== 16) throw new Error('tc_tea 密钥长度必须为 16 字节');
  const k = new Uint32Array(4);
  for (let i = 0; i < 4; i++) k[i] = readU32BE(key, i * 4);
  return k;
}

/** 单块解密（y/z 为 64 位块的两半）。 */
export function teaDecryptBlock(
  y: number,
  z: number,
  k: Uint32Array,
): { y: number; z: number } {
  let sum = Math.imul(DELTA, ROUNDS) >>> 0;
  let vy = y >>> 0;
  let vz = z >>> 0;
  for (let round = 0; round < ROUNDS; round++) {
    vz = (vz - teaF(vy, sum, k[2], k[3])) >>> 0;
    vy = (vy - teaF(vz, sum, k[0], k[1])) >>> 0;
    sum = (sum - DELTA) >>> 0;
  }
  return { y: vy, z: vz };
}

/** 单块加密（仅测试/构造样本用）。 */
export function teaEncryptBlock(
  y: number,
  z: number,
  k: Uint32Array,
): { y: number; z: number } {
  let sum = 0;
  let vy = y >>> 0;
  let vz = z >>> 0;
  for (let round = 0; round < ROUNDS; round++) {
    sum = (sum + DELTA) >>> 0;
    vy = (vy + teaF(vz, sum, k[0], k[1])) >>> 0;
    vz = (vz + teaF(vy, sum, k[2], k[3])) >>> 0;
  }
  return { y: vy, z: vz };
}

function toKeyBytes(key: Uint8Array | string): Uint8Array {
  if (typeof key === 'string') {
    const bytes = new Uint8Array(key.length);
    for (let i = 0; i < key.length; i++) bytes[i] = key.charCodeAt(i) & 0xff;
    return bytes;
  }
  return key;
}

/**
 * tc_tea CBC 解密，返回去掉填充后的明文。
 *
 * 每 8 字节：
 *   cb = BE64(cipher); t = cb ^ iv2; n = TEA_decrypt(t); p = n ^ iv1; iv1 = cb; iv2 = n
 * 全部逆向填充（1 字节 pad 长度 + 2 字节盐 + 末尾 7 字节 0）都由头部/尾部推导，
 * 任一校验失败都抛错——ekey 错误时通常会在这里先炸，UI 据此提示「密钥无效」。
 */
export function tcTeaCbcDecrypt(cipher: Uint8Array, key: Uint8Array | string): Uint8Array {
  const len = cipher.length;
  if (len < 16 || len % 8 !== 0) throw new Error('tc_tea 密文长度非法');
  const k = teaKeyToU32(toKeyBytes(key));
  const plain = new Uint8Array(len);
  let iv1a = 0;
  let iv1b = 0;
  let iv2a = 0;
  let iv2b = 0;
  for (let pos = 0; pos < len; pos += 8) {
    const ca = readU32BE(cipher, pos);
    const cb = readU32BE(cipher, pos + 4);
    const ra = (ca ^ iv2a) >>> 0;
    const rb = (cb ^ iv2b) >>> 0;
    const n = teaDecryptBlock(ra, rb, k);
    writeU32BE(plain, pos, (n.y ^ iv1a) >>> 0);
    writeU32BE(plain, pos + 4, (n.z ^ iv1b) >>> 0);
    iv1a = ca;
    iv1b = cb;
    iv2a = n.y;
    iv2b = n.z;
  }

  const padSize = plain[0] & 0x07;
  const start = 1 + padSize + 2;
  const end = len - 7;
  if (start > end) throw new Error('tc_tea 填充长度非法');
  for (let i = end; i < len; i++) {
    if (plain[i] !== 0) throw new Error('tc_tea 尾部校验失败（密钥可能不正确）');
  }
  return plain.subarray(start, end);
}

/**
 * tc_tea CBC 加密（仅测试/构造样本用，round-trip 与 decrypt 严格对称）。
 * salt 缺省时用 0x00,0x01 便于确定性测试。
 */
export function tcTeaCbcEncrypt(
  plain: Uint8Array,
  key: Uint8Array | string,
  salt: Uint8Array = Uint8Array.from([0x00, 0x01]),
): Uint8Array {
  const padSize = (8 - ((plain.length + 10) % 8)) % 8;
  const headerLen = 1 + padSize + 2;
  const total = headerLen + plain.length + 7;
  const buf = new Uint8Array(total);
  buf[0] = (salt[0] & 0xf8) | padSize;
  buf[1] = salt[0];
  buf[2] = salt[1];
  buf.set(plain, headerLen);
  // 末尾 7 字节保持 0

  const k = teaKeyToU32(toKeyBytes(key));
  const out = new Uint8Array(total);
  let iv1a = 0;
  let iv1b = 0;
  let iv2a = 0;
  let iv2b = 0;
  for (let pos = 0; pos < total; pos += 8) {
    const pa = readU32BE(buf, pos);
    const pb = readU32BE(buf, pos + 4);
    // decrypt 的逆：n = p ^ iv1；c = TEA_enc(n) ^ iv2；iv1 := c；iv2 := n
    const na = (pa ^ iv1a) >>> 0;
    const nb = (pb ^ iv1b) >>> 0;
    const enc = teaEncryptBlock(na, nb, k);
    const ca = (enc.y ^ iv2a) >>> 0;
    const cb = (enc.z ^ iv2b) >>> 0;
    writeU32BE(out, pos, ca);
    writeU32BE(out, pos + 4, cb);
    iv1a = ca;
    iv1b = cb;
    iv2a = na;
    iv2b = nb;
  }
  return out;
}
