import { describe, expect, it } from 'vitest';
import {
  FIRST_SEGMENT_SIZE,
  MAP_KEY_SIZE,
  OTHER_SEGMENT_SIZE,
  Qmc2MapCipher,
  Qmc2Rc4Cipher,
  QmcRc4,
  buildRc4KeyStream,
  compressKey,
  createQmc2Cipher,
  decryptQMC2Rc4,
  getSegmentKey,
  hashKey,
} from '../qmc/qmc2';
import { bytesToHex, hexToBytes, latin1Encode } from '../bytes';

/** a-z A-Z 0-9 循环 — 上游向量都用这个模式构造长密钥。 */
const CYCLE = latin1Encode('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');

function cycleKey(size: number, seed = 0): Uint8Array {
  const key = new Uint8Array(size);
  for (let i = 0; i < size; i++) key[i] = CYCLE[(i + seed) % CYCLE.length];
  return key;
}

describe('qmc2: key_compress', () => {
  it('325 字节密钥压缩结果与上游 128 字节向量逐字节一致', () => {
    expect(bytesToHex(compressKey(cycleKey(325)))).toBe(
      '79f400759e3600148a6300b4be770017ba0037000000bf8041bf83ddbc5c0243' +
        '148249020055be6dbf49808e4300fa4167a817f4ae161500c13782dd36213855' +
        '0079419e42c136facf35000041dd4342174d8e8add00bef538b4bf007acc4d02' +
        '00cfc1c102a80016c1bfc242004900c1c2f5001741dc83c2009e41c171360080',
    );
  });

  it('压缩结果首字节是 0x79 而不是 rotl8 的 0x72（规格修正点）', () => {
    const out = compressKey(cycleKey(325));
    expect(out.length).toBe(MAP_KEY_SIZE);
    expect(out[0], '((b<<s)|(b>>>s)) & 0xFF，两侧位移量相同').toBe(0x79);
    expect(out[0], '若实现成 rotl8(b, s) 会得到 0x72').not.toBe(0x72);
  });

  it('空密钥抛错', () => {
    expect(() => compressKey(new Uint8Array(0))).toThrow(/为空/);
  });

  it('相同密钥多次压缩结果稳定（无隐藏状态）', () => {
    const key = cycleKey(325);
    expect(bytesToHex(compressKey(key))).toBe(bytesToHex(compressKey(key)));
  });
});

describe('qmc2: hashKey', () => {
  it('hash("hello world") = 4045008896', () => {
    expect(hashKey(latin1Encode('hello world'))).toBe(4045008896);
  });

  it('遇到 0x00 字节跳过（不参与乘法）', () => {
    expect(hashKey(Uint8Array.from([0x68, 0x00, 0x69]))).toBe(hashKey(Uint8Array.from([0x68, 0x69])));
  });

  it('空密钥返回初值 1', () => {
    expect(hashKey(new Uint8Array(0))).toBe(1);
  });
});

describe('qmc2: getSegmentKey', () => {
  it('seed=0 时恒为 0', () => {
    expect(getSegmentKey(1, 0, 12345)).toBe(0);
    expect(getSegmentKey(999999, 0, 4045008896)).toBe(0);
  });

  it('上游三个常规向量', () => {
    expect(getSegmentKey(1, 123, 12345)).toBe(5018);
    expect(getSegmentKey(51, 35, 516402887)).toBe(28373784);
  });

  it('结果可超过 2^32（禁止用 >>>0 截断）', () => {
    const value = getSegmentKey(0, 66, 3908240000);
    expect(value).toBe(5921575757);
    expect(value > 0xffffffff, '5921575757 > 2^32，说明不能截断成 u32').toBe(true);
  });
});

describe('qmc2: RC4 变体', () => {
  it('QmcRc4 核心向量：key="this is a test key" 加密 "hello world"', () => {
    const rc4 = new QmcRc4(latin1Encode('this is a test key'));
    const out = latin1Encode('hello world');
    for (let i = 0; i < out.length; i++) out[i] ^= rc4.generate();
    expect(bytesToHex(out)).toBe('68756b6464247f607c7d60');
  });

  it('上游 256 字节整块向量解密后全 0', () => {
    const key = cycleKey(512);
    const cipher = hexToBytes(
      '395a4f753871376b3651536d7a66534b66506934676c337a5562355a32754f6844526d65756e3952307a686273593948555773325a7064504e526a634d3937767247644d626d586875473756696b4a79666370395934436b45325a313877704351796a62323365584a4d334e706262674c54786464776e7237415439425247321ae41b716829b36eadc52812d6a44b067adc901599d6bf72a230376b5cd62f35148ad6fb9fee7d2db737f20b6e00fba03c40f336b276200f9ea5a31560231529a191bffb1295aa8d92c60b8d4999a5e005cfb6ac07545828f996d19afe0b3cfb0b257a435a33c37afc33a3c26548298d2c8f4e88fd44fdd5cab98d624a48201d',
    );
    expect(cipher.length).toBe(256);
    const out = cipher.slice();
    decryptQMC2Rc4(out, 0, key, hashKey(key), buildRc4KeyStream(key));
    expect(out.every((b) => b === 0), '整块解出应为 256 个 0').toBe(true);
  });

  it('分块大小不影响 RC4 结果（1/7/333/1024/4096 与整块一致）', () => {
    const key = cycleKey(512);
    const cipher = hexToBytes(
      '395a4f753871376b3651536d7a66534b66506934676c337a5562355a32754f6844526d65756e3952307a686273593948555773325a7064504e526a634d3937767247644d626d586875473756696b4a79666370395934436b45325a313877704351796a62323365584a4d334e706262674c54786464776e7237415439425247321ae41b716829b36eadc52812d6a44b067adc901599d6bf72a230376b5cd62f35148ad6fb9fee7d2db737f20b6e00fba03c40f336b276200f9ea5a31560231529a191bffb1295aa8d92c60b8d4999a5e005cfb6ac07545828f996d19afe0b3cfb0b257a435a33c37afc33a3c26548298d2c8f4e88fd44fdd5cab98d624a48201d',
    );
    const hash = hashKey(key);
    const stream = buildRc4KeyStream(key);
    for (const size of [1, 7, 333, 1024, 4096]) {
      const buf = cipher.slice();
      for (let pos = 0; pos < buf.length; pos += size) {
        decryptQMC2Rc4(buf.subarray(pos, Math.min(pos + size, buf.length)), pos, key, hash, stream);
      }
      expect(buf.every((b) => b === 0), `分块 ${size} 字节时结果应与整块一致`).toBe(true);
    }
  });

  it('跨 0x80 / 0x1400 分段边界时分块仍一致', () => {
    const key = cycleKey(400, 3);
    const hash = hashKey(key);
    const stream = buildRc4KeyStream(key);
    const size = FIRST_SEGMENT_SIZE + OTHER_SEGMENT_SIZE * 2 + 50;
    const source = new Uint8Array(size);
    for (let i = 0; i < size; i++) source[i] = (i * 29 + 11) & 0xff;

    const whole = source.slice();
    decryptQMC2Rc4(whole, 0, key, hash, stream);

    for (const chunk of [1, 0x7f, 0x80, 0x81, 0x1400, 0x1401, 0x2000]) {
      const buf = source.slice();
      for (let pos = 0; pos < buf.length; pos += chunk) {
        decryptQMC2Rc4(
          buf.subarray(pos, Math.min(pos + chunk, buf.length)),
          pos,
          key,
          hash,
          stream,
        );
      }
      expect(bytesToHex(buf), `chunk=${chunk} 应与整块解密一致`).toBe(bytesToHex(whole));
    }
  });
});

describe('qmc2: cipher 选路与往返', () => {
  it('key 长度 300 走 Map 路径', () => {
    expect(createQmc2Cipher(cycleKey(300)).kind).toBe('map');
  });

  it('key 长度 301 走 RC4 路径', () => {
    expect(createQmc2Cipher(cycleKey(301)).kind).toBe('rc4');
  });

  it('空密钥抛错', () => {
    expect(() => createQmc2Cipher(new Uint8Array(0))).toThrow(/为空/);
  });

  it('Map cipher 加密→解密往返一致（40 字节）', () => {
    const cipher = new Qmc2MapCipher(cycleKey(39));
    const plain = latin1Encode('fLaC').slice();
    const data = new Uint8Array(40);
    data.set(plain, 0);
    for (let i = 4; i < 40; i++) data[i] = i;
    const enc = data.slice();
    cipher.decrypt(enc, 0);
    expect(bytesToHex(enc)).not.toBe(bytesToHex(data));
    cipher.decrypt(enc, 0);
    expect(bytesToHex(enc), 'XOR 变换应自反').toBe(bytesToHex(data));
  });

  it('RC4 cipher 加密→解密往返一致（40 字节）', () => {
    const cipher = new Qmc2Rc4Cipher(cycleKey(400, 5));
    const data = new Uint8Array(40);
    data.set(latin1Encode('fLaC'), 0);
    for (let i = 4; i < 40; i++) data[i] = (i * 7) & 0xff;
    const enc = data.slice();
    cipher.decrypt(enc, 0);
    expect(bytesToHex(enc)).not.toBe(bytesToHex(data));
    cipher.decrypt(enc, 0);
    expect(bytesToHex(enc)).toBe(bytesToHex(data));
  });

  it('分段偏移非 0 时 Map cipher 与 QMC1 变换等价', () => {
    const key = cycleKey(39);
    const cipher = new Qmc2MapCipher(key);
    const data = Uint8Array.from([1, 2, 3, 4]);
    const direct = data.slice();
    cipher.decrypt(direct, 0x9000);
    const viaQmc1 = data.slice();
    // 0x9000 > 0x7FFF → 回绕成 0x1001
    const wrapped = 0x9000 % 0x7fff;
    for (let i = 0; i < viaQmc1.length; i++) {
      viaQmc1[i] ^= cipher.compressedKey[(wrapped + i) & 0x7f];
    }
    expect(bytesToHex(direct)).toBe(bytesToHex(viaQmc1));
  });
});
