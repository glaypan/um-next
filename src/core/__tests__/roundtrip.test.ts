import { describe, expect, it } from 'vitest';
import { decryptFile } from '../detect';
import { decryptQMC1 } from '../qmc/qmc1';
import { createQmc2Cipher } from '../qmc/qmc2';
import { decryptEkey } from '../qmc/ekey';
import { buildMusicExTail, buildNcm, makeEkeyV1, makeFakeAudio } from './helpers/build';
import { bytesToHex, concatBytes } from '../bytes';

const EKEY_V1 =
  'MTIzNDU2NzhN2csrbjHfIPH0BrVByijvtaAXJdb4Iy7P/ktYG6Wxly+Vz5sZ5nqDPUHoVBuuzSQ=';

/**
 * 大缓冲区逐字节比较：不用 bytesToHex（4 MiB → 840 万字符字符串会拖慢整个测试套件）。
 */
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  expect(actual.length, `${label}：长度不一致`).toBe(expected.length);
  let firstDiff = -1;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      firstDiff = i;
      break;
    }
  }
  expect(firstDiff, `${label}：第一个不一致的字节偏移（-1 表示完全一致）`).toBe(-1);
}

/** 40 字节（0x80 首段内最小样本）与 1 MiB（跨多个 0x1400 分段）。 */
const SIZES: Array<{ label: string; size: number }> = [
  { label: '40 字节', size: 40 },
  { label: '1 MiB', size: 1024 * 1024 },
];

describe('roundtrip: QMC1', () => {
  for (const { label, size } of SIZES) {
    it(`QMC1 ${label}音频 加密→解密 逐字节一致`, () => {
      const audio = makeFakeAudio(size);
      const enc = audio.slice();
      decryptQMC1(enc, 0);
      expect(bytesToHex(enc.subarray(0, 8))).not.toBe(bytesToHex(audio.subarray(0, 8)));
      const out = decryptFile(enc, { fileName: 'a.qmcflac' });
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') return;
      expect(out.cipher).toBe('QMC1');
      expectBytesEqual(out.data, audio, `QMC1 ${label}`);
    });
  }
});

describe('roundtrip: QMC2/Map（ekey 39 字节 key）', () => {
  for (const { label, size } of SIZES) {
    it(`QMC2/Map ${label}音频 + MusicEx 尾部 往返一致`, () => {
      const audio = makeFakeAudio(size);
      const cipher = createQmc2Cipher(decryptEkey(EKEY_V1));
      const enc = audio.slice();
      cipher.decrypt(enc, 0);
      const file = concatBytes(enc, buildMusicExTail('mid-1', 'f.mflac'));
      const out = decryptFile(file, { ekey: EKEY_V1 });
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') return;
      expect(out.cipher).toBe('QMC2/Map');
      expectBytesEqual(out.data, audio, `QMC2/Map ${label}（尾部必须精确裁掉）`);
    });
  }
});

describe('roundtrip: QMC2/RC4（500 字节 key）', () => {
  const longKey = (() => {
    const key = new Uint8Array(500);
    for (let i = 0; i < key.length; i++) key[i] = (i * 13 + 7) & 0xff;
    return key;
  })();
  const ekey = makeEkeyV1(longKey);

  for (const { label, size } of SIZES) {
    it(`QMC2/RC4 ${label}音频 往返一致`, () => {
      const audio = makeFakeAudio(size);
      const cipher = createQmc2Cipher(decryptEkey(ekey));
      expect(cipher.kind, '500 字节 key 必须走 RC4 路径').toBe('rc4');
      const enc = audio.slice();
      cipher.decrypt(enc, 0);
      const out = decryptFile(enc, { ekey });
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') return;
      expect(out.cipher).toBe('QMC2/RC4');
      expectBytesEqual(out.data, audio, `QMC2/RC4 ${label}`);
    });
  }
});

describe('roundtrip: NCM', () => {
  for (const { label, size } of SIZES) {
    it(`NCM ${label}音频 往返一致（含 metadata / 封面偏移）`, () => {
      const audio = makeFakeAudio(size);
      const cover = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);
      const built = buildNcm({ audio, cover });
      const out = decryptFile(built.file.slice(), { fileName: 'b.ncm' });
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') return;
      expect(out.cipher).toBe('NCM');
      expect(out.cover?.mime).toBe('image/jpeg');
      expectBytesEqual(out.data, audio, `NCM ${label}`);
    });
  }
});

describe('roundtrip: 边界对齐', () => {
  it('QMC2/Map 在 0x80 / 0x1400 分段边界长度上仍然正确', () => {
    const cipher = createQmc2Cipher(decryptEkey(EKEY_V1));
    for (const size of [0x7f, 0x80, 0x81, 0x13ff, 0x1400, 0x1401]) {
      const audio = makeFakeAudio(size);
      const enc = audio.slice();
      cipher.decrypt(enc, 0);
      const out = decryptFile(enc, { ekey: EKEY_V1 });
      expect(out.status, `size=${size}`).toBe('ok');
      if (out.status !== 'ok') continue;
      expectBytesEqual(out.data, audio, `size=${size}`);
    }
  });

  it('NCM 最小可识别样本（4 字节 fLaC）也能解出', () => {
    // 少于 4 字节无法通过音频魔数校验，故 4 字节是可解出的最小边界
    const audio = makeFakeAudio(4);
    const built = buildNcm({ audio });
    const parsed = decryptFile(built.file.slice());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expectBytesEqual(parsed.data, audio, '4 字节样本');
  });

  it('decryptFile 的 4 MiB 分块路径正确（QMC1，跨块边界）', () => {
    const size = 4 * 1024 * 1024 + 1;
    const audio = makeFakeAudio(size);
    const enc = audio.slice();
    decryptQMC1(enc, 0);
    const out = decryptFile(enc, { fileName: 'big.qmcflac' });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expectBytesEqual(out.data, audio, 'QMC1 4 MiB+1');
  });

  it('decryptFile 的 4 MiB 分块路径正确（QMC2/Map，带尾部裁剪）', () => {
    const size = 4 * 1024 * 1024 + 1;
    const audio = makeFakeAudio(size);
    const cipher = createQmc2Cipher(decryptEkey(EKEY_V1));
    const enc = audio.slice();
    cipher.decrypt(enc, 0);
    const file = concatBytes(enc, buildMusicExTail('mid-big', 'big.mflac'));
    const out = decryptFile(file, { ekey: EKEY_V1 });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.data.length, '尾部必须精确裁掉').toBe(size);
    expectBytesEqual(out.data, audio, 'QMC2/Map 4 MiB+1');
  });
});

describe('roundtrip: 性能冒烟', () => {
  it('8 MiB QMC2/RC4 分块解密 < 2s', () => {
    const cipher = createQmc2Cipher(longKeyForPerf());
    const size = 8 * 1024 * 1024;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 7 + 3) & 0xff;
    // 先加密一次（等价于构造 cipher 文件），再单独计时解密
    cipher.decrypt(data, 0);

    const cipher2 = createQmc2Cipher(longKeyForPerf());
    const start = performance.now();
    cipher2.decrypt(data, 0);
    const elapsed = performance.now() - start;
    // 软断言：记录耗时；超过 2s 视为性能回归（Node 环境实测远低于此）
    expect(elapsed, `8 MiB RC4 解密耗时 ${elapsed.toFixed(1)}ms`).toBeLessThan(2000);
  });
});

function longKeyForPerf(): Uint8Array {
  const key = new Uint8Array(512);
  for (let i = 0; i < key.length; i++) key[i] = (i * 31 + 11) & 0xff;
  return key;
}
