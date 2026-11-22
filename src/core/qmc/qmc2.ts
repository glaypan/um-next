/**
 * QMC2：由 ekey 解出的长密钥决定走两条完全不同的路径。
 *
 *  - key.length ∈ [1, 300] → **Map**：把长密钥压缩成 128 字节，复用 QMC1 的 XOR 变换。
 *  - key.length > 300      → **RC4 变体**：状态表长度 = key 长度（不是 256！），另加分段 skip。
 *
 * 关键陷阱：
 *  1. `getSegmentKey` 全程 f64，结果可超过 2^32（上游用例 5921575757），**禁止 >>>0 / |0**。
 *  2. RC4 变体的状态表尺寸、KSA/PRGA 的模数都是 key.length。
 *  3. 首段 0x80 与后续 0x1400 分段的密钥来源不同；分段不能跨界。
 */
import { qmc1Transform } from './qmc1';

export const FIRST_SEGMENT_SIZE = 0x80;
export const OTHER_SEGMENT_SIZE = 0x1400;
export const RC4_STREAM_CACHE_SIZE = 0x1600;
export const MAP_KEY_SIZE = 128;
const INDEX_OFFSET = 71214;

/** Map 路径：长密钥压缩成 128 字节。 */
export function compressKey(longKey: Uint8Array): Uint8Array {
  const n = longKey.length;
  if (n === 0) throw new Error('QMC2 密钥为空');
  const out = new Uint8Array(MAP_KEY_SIZE);
  for (let i = 0; i < MAP_KEY_SIZE; i++) {
    const idx = (i * i + INDEX_OFFSET) % n;
    const v = longKey[idx];
    const shift = (idx + 4) % 8;
    // 上游实现是 `v.wrapping_shl(sh) | v.wrapping_shr(sh)`：
    // 注意**两侧位移量相同**（不是 8-sh 的循环左移）。shift = 0 时退化为 v 本身。
    // 该公式由上游 325 字节测试向量逐字节反推确认（见 scripts/selfcheck.ts）。
    out[i] = ((v << shift) | (v >>> shift)) & 0xff;
  }
  return out;
}

/** RC4 路径的密钥哈希（返回值以 f64 参与后续浮点运算）。 */
export function hashKey(key: Uint8Array): number {
  let h = 1 >>> 0;
  for (let i = 0; i < key.length; i++) {
    const v = key[i];
    if (v === 0) continue;
    const next = Math.imul(h, v) >>> 0;
    if (next === 0 || next <= h) break;
    h = next;
  }
  return h;
}

/**
 * 分段密钥。全 f64 运算，结果可能 > 2^32，**不要截断成 u32**。
 * `getSegmentKey(0, 66, 3908240000) === 5921575757`
 */
export function getSegmentKey(id: number, seed: number, hash: number): number {
  if (seed === 0) return 0;
  return Math.floor((hash / ((id + 1) * seed)) * 100);
}

/** RC4 变体：状态表长度 = key 长度。 */
export class QmcRc4 {
  private readonly s: Uint8Array;
  private i = 0;
  private j = 0;

  constructor(key: Uint8Array) {
    const n = key.length;
    if (n === 0) throw new Error('QMC2 密钥为空');
    this.s = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.s[i] = i & 0xff;
    let j = 0;
    for (let i = 0; i < n; i++) {
      j = (j + this.s[i] + key[i % n]) % n;
      const tmp = this.s[i];
      this.s[i] = this.s[j];
      this.s[j] = tmp;
    }
  }

  /** PRGA（模 n，非 256）。 */
  generate(): number {
    const n = this.s.length;
    this.i = (this.i + 1) % n;
    this.j = (this.j + this.s[this.i]) % n;
    const tmp = this.s[this.i];
    this.s[this.i] = this.s[this.j];
    this.s[this.j] = tmp;
    return this.s[(this.s[this.i] + this.s[this.j]) % n];
  }
}

/** 预生成 0x1600 字节 keystream（构造 cipher 时一次，别每次 decrypt 重建）。 */
export function buildRc4KeyStream(key: Uint8Array): Uint8Array {
  const stream = new Uint8Array(RC4_STREAM_CACHE_SIZE);
  const rc4 = new QmcRc4(key);
  for (let i = 0; i < RC4_STREAM_CACHE_SIZE; i++) stream[i] = rc4.generate();
  return stream;
}

/**
 * RC4 路径的原地解密。`offset` 为 data[0] 在音频流中的绝对偏移；
 * 本函数内部会自动按段切分，因此调用方传任意块长都安全（块跨界也没问题）。
 */
export function decryptQMC2Rc4(
  data: Uint8Array,
  offset: number,
  key: Uint8Array,
  hash: number,
  keyStream: Uint8Array,
): void {
  const n = key.length;
  let pos = 0;
  let off = offset;

  // ① 首段 0x80：逐字节用自己的 segment key 取 key[idx]
  if (off < FIRST_SEGMENT_SIZE) {
    const len = Math.min(FIRST_SEGMENT_SIZE - off, data.length - pos);
    for (let i = 0; i < len; i++) {
      const absolute = off + i;
      const seed = key[absolute % n];
      const idx = getSegmentKey(absolute, seed, hash) % n;
      data[pos + i] ^= key[idx];
    }
    pos += len;
    off += len;
  }

  // ② 之后按 0x1400 分段，用 keystream[skip + 段内偏移] 取流
  while (pos < data.length) {
    const id = Math.floor(off / OTHER_SEGMENT_SIZE);
    const blockOffset = off % OTHER_SEGMENT_SIZE;
    const segSeed = key[id % n];
    const skip = getSegmentKey(id, segSeed, hash) % 512;
    const len = Math.min(OTHER_SEGMENT_SIZE - blockOffset, data.length - pos);
    for (let i = 0; i < len; i++) {
      data[pos + i] ^= keyStream[skip + blockOffset + i];
    }
    pos += len;
    off += len;
  }
}

export type Qmc2CipherKind = 'map' | 'rc4';

export interface Qmc2Cipher {
  kind: Qmc2CipherKind;
  /** 原地解密一块数据，offset 为音频流绝对偏移。 */
  decrypt(data: Uint8Array, offset: number): void;
}

/** Map 路径 cipher：压缩密钥 + QMC1 变换（整块直接用绝对偏移）。 */
export class Qmc2MapCipher implements Qmc2Cipher {
  readonly kind = 'map' as const;
  readonly compressedKey: Uint8Array;

  constructor(longKey: Uint8Array) {
    if (longKey.length === 0) throw new Error('QMC2 密钥为空');
    this.compressedKey = compressKey(longKey);
  }

  decrypt(data: Uint8Array, offset: number): void {
    const key = this.compressedKey;
    for (let i = 0; i < data.length; i++) {
      data[i] = qmc1Transform(key, data[i], offset + i);
    }
  }
}

/** RC4 路径 cipher：构造时生成一次 5632 字节 keystream。 */
export class Qmc2Rc4Cipher implements Qmc2Cipher {
  readonly kind = 'rc4' as const;
  private readonly key: Uint8Array;
  private readonly hash: number;
  private readonly keyStream: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.length === 0) throw new Error('QMC2 密钥为空');
    this.key = key;
    this.hash = hashKey(key);
    this.keyStream = buildRc4KeyStream(key);
  }

  decrypt(data: Uint8Array, offset: number): void {
    decryptQMC2Rc4(data, offset, this.key, this.hash, this.keyStream);
  }
}

/** 按密钥长度选路：<= 300 → Map，> 300 → RC4。 */
export function createQmc2Cipher(key: Uint8Array): Qmc2Cipher {
  if (key.length === 0) throw new Error('QMC2 密钥为空');
  return key.length <= 300 ? new Qmc2MapCipher(key) : new Qmc2Rc4Cipher(key);
}
