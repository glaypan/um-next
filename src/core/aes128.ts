/**
 * 纯 TypeScript 的 AES-128 ECB 实现（含 PKCS#7）。
 *
 * 为什么自己写：WebCrypto **不支持 ECB 模式**（subtle.encrypt 只允许 CBC/CTR/GCM/KW），
 * 而网易云 NCM 的 content key / metadata 都是 AES-128-ECB。上游用私有 wasm 包实现，
 * 本仓库不引入私有依赖，因此按 FIPS-197 直接手写（查表实现，足够快且便于单测）。
 *
 * 解密是生产路径；加密仅用于构造测试样本（NCM 合成样本需要）。
 */

function rotl8(x: number, n: number): number {
  return ((x << n) | (x >>> (8 - n))) & 0xff;
}

/** 生成 S 盒：GF(2^8) 乘法逆元 + 仿射变换。 */
function buildSBox(): { sbox: Uint8Array; inv: Uint8Array } {
  const sbox = new Uint8Array(256);
  const inv = new Uint8Array(256);
  let p = 1;
  let q = 1;
  do {
    // p ← p * 3
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    // q ← q / 3
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    sbox[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  sbox[0] = 0x63;
  for (let i = 0; i < 256; i++) inv[sbox[i]] = i;
  return { sbox, inv };
}

const { sbox: SBOX, inv: INV_SBOX } = buildSBox();

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

/** AES-128 密钥扩展：16 字节密钥 → 11 组轮密钥（176 字节）。 */
export function aes128ExpandKey(key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error('AES-128 密钥长度必须为 16 字节');
  const w = new Uint8Array(176);
  w.set(key, 0);
  let offset = 16;
  let rconIndex = 0;
  while (offset < 176) {
    const t0 = w[offset - 4];
    const t1 = w[offset - 3];
    const t2 = w[offset - 2];
    const t3 = w[offset - 1];
    if (offset % 16 === 0) {
      // RotWord + SubWord + Rcon
      const s0 = SBOX[t1] ^ RCON[rconIndex++];
      const s1 = SBOX[t2];
      const s2 = SBOX[t3];
      const s3 = SBOX[t0];
      w[offset] = w[offset - 16] ^ s0;
      w[offset + 1] = w[offset - 15] ^ s1;
      w[offset + 2] = w[offset - 14] ^ s2;
      w[offset + 3] = w[offset - 13] ^ s3;
    } else {
      w[offset] = w[offset - 16] ^ t0;
      w[offset + 1] = w[offset - 15] ^ t1;
      w[offset + 2] = w[offset - 14] ^ t2;
      w[offset + 3] = w[offset - 13] ^ t3;
    }
    offset += 4;
  }
  return w;
}

function gfMul(a: number, b: number): number {
  let result = 0;
  let x = a & 0xff;
  let y = b & 0xff;
  while (y) {
    if (y & 1) result ^= x;
    const hi = x & 0x80;
    x = (x << 1) & 0xff;
    if (hi) x ^= 0x1b;
    y >>>= 1;
  }
  return result & 0xff;
}

function addRoundKey(state: Uint8Array, roundKeys: Uint8Array, round: number): void {
  const base = round * 16;
  for (let i = 0; i < 16; i++) state[i] ^= roundKeys[base + i];
}

function subBytes(state: Uint8Array, table: Uint8Array): void {
  for (let i = 0; i < 16; i++) state[i] = table[state[i]];
}

/** 行移位：第 r 行循环左移 r 字节（state 为列主序，索引 = row + 4*col）。 */
function shiftRows(state: Uint8Array): void {
  const tmp = state.slice();
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      state[row + 4 * col] = tmp[row + 4 * ((col + row) & 3)];
    }
  }
}

/** 逆行移位：第 r 行循环右移 r 字节。 */
function invShiftRows(state: Uint8Array): void {
  const tmp = state.slice();
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      state[row + 4 * ((col + row) & 3)] = tmp[row + 4 * col];
    }
  }
}

function mixColumns(state: Uint8Array): void {
  for (let col = 0; col < 4; col++) {
    const i = col * 4;
    const a0 = state[i];
    const a1 = state[i + 1];
    const a2 = state[i + 2];
    const a3 = state[i + 3];
    state[i] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3;
    state[i + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3;
    state[i + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3);
    state[i + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2);
  }
}

function invMixColumns(state: Uint8Array): void {
  for (let col = 0; col < 4; col++) {
    const i = col * 4;
    const a0 = state[i];
    const a1 = state[i + 1];
    const a2 = state[i + 2];
    const a3 = state[i + 3];
    state[i] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
    state[i + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
    state[i + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
    state[i + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
  }
}

/** 解密单个 16 字节分组。 */
export function aes128DecryptBlock(block: Uint8Array, roundKeys: Uint8Array): Uint8Array {
  if (block.length !== 16) throw new Error('AES 分组长度必须为 16 字节');
  const state = block.slice();
  addRoundKey(state, roundKeys, 10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(state);
    subBytes(state, INV_SBOX);
    addRoundKey(state, roundKeys, round);
    invMixColumns(state);
  }
  invShiftRows(state);
  subBytes(state, INV_SBOX);
  addRoundKey(state, roundKeys, 0);
  return state;
}

/** 加密单个 16 字节分组（仅测试/构造样本用）。 */
export function aes128EncryptBlock(block: Uint8Array, roundKeys: Uint8Array): Uint8Array {
  if (block.length !== 16) throw new Error('AES 分组长度必须为 16 字节');
  const state = block.slice();
  addRoundKey(state, roundKeys, 0);
  for (let round = 1; round <= 9; round++) {
    subBytes(state, SBOX);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, roundKeys, round);
  }
  subBytes(state, SBOX);
  shiftRows(state);
  addRoundKey(state, roundKeys, 10);
  return state;
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
 * AES-128-ECB 解密 + 去 PKCS#7 填充。
 * 密文长度必须是 16 的整数倍且非空，否则抛错（NCM 头部损坏时通常走到这里）。
 */
export function aes128EcbDecryptPkcs7(cipher: Uint8Array, key: Uint8Array | string): Uint8Array {
  if (cipher.length === 0 || cipher.length % 16 !== 0) {
    throw new Error('AES-128-ECB 密文长度非法（必须为 16 的非零整数倍）');
  }
  const roundKeys = aes128ExpandKey(toKeyBytes(key));
  const out = new Uint8Array(cipher.length);
  for (let offset = 0; offset < cipher.length; offset += 16) {
    out.set(aes128DecryptBlock(cipher.subarray(offset, offset + 16), roundKeys), offset);
  }
  // 去 PKCS#7 填充（严格校验）
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 16 || pad > out.length) throw new Error('AES PKCS#7 填充非法');
  for (let i = out.length - pad; i < out.length; i++) {
    if (out[i] !== pad) throw new Error('AES PKCS#7 填充非法');
  }
  return out.subarray(0, out.length - pad);
}

/** AES-128-ECB 加密 + PKCS#7 填充（仅测试/构造样本用）。 */
export function aes128EcbEncryptPkcs7(plain: Uint8Array, key: Uint8Array | string): Uint8Array {
  const pad = 16 - (plain.length % 16);
  const total = plain.length + pad;
  const input = new Uint8Array(total);
  input.set(plain, 0);
  input.fill(pad, plain.length);
  const roundKeys = aes128ExpandKey(toKeyBytes(key));
  const out = new Uint8Array(total);
  for (let offset = 0; offset < total; offset += 16) {
    out.set(aes128EncryptBlock(input.subarray(offset, offset + 16), roundKeys), offset);
  }
  return out;
}
