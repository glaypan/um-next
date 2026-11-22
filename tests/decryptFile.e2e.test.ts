// @vitest-environment node
/**
 * 文件级端到端测试：读 `tests/fixtures/*` 真实字节 → `decryptFile` → 与 manifest 的
 * 明文 sha256 比对。这是「用户点下载」路径的最后一道闸门。
 *
 * 用 Node 的 `crypto` 计算 sha256、并交叉验证 AES-128-ECB（仅测试内使用，
 * 生产代码不依赖 Node API）。
 */
import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decryptFile } from '../src/core/detect';
import {
  aes128EcbDecryptPkcs7,
  aes128EcbEncryptPkcs7,
} from '../src/core/aes128';
import { bytesToHex, readU32LE, latin1Decode, latin1Encode } from '../src/core/bytes';
import { NCM_METADATA_KEY } from '../src/core/ncm/index';

/** node:crypto 的 AES-128-ECB + PKCS#7（默认 autopadding）加密，返回 hex。 */
function nodeAesEcb(plain: Uint8Array, key: Uint8Array): string {
  const c = createCipheriv('aes-128-ecb', key, null);
  const out = Buffer.concat([c.update(plain), c.final()]);
  return out.toString('hex');
}

interface ManifestEntry {
  file: string;
  sha256: string;
  ext: string;
  needsEkey: boolean;
  ekeyFile: string | null;
  cipher: string;
  fileSha256: string;
  size: number;
  plaintextSize: number;
  note?: string;
}

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const manifest = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'),
) as ManifestEntry[];

const readFixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const ekeyOf = (entry: ManifestEntry): string | undefined =>
  entry.ekeyFile ? readFileSync(path.join(FIXTURE_DIR, entry.ekeyFile), 'utf8').trim() : undefined;

describe('fixtures: 清单与文件完整性', () => {
  it('manifest 恰好包含 6 个样本，且覆盖 6 种容器/算法', () => {
    expect(manifest.length).toBe(6);
    expect(new Set(manifest.map((m) => m.cipher))).toEqual(
      new Set(['NCM', 'QMC1', 'QMC2/Map', 'AUDIO']),
    );
    const files = manifest.map((m) => m.file).sort();
    expect(files).toEqual(
      [
        'sample-ncm.ncm',
        'sample-plain.flac',
        'sample-qmc-musicex.mflac',
        'sample-qmc-qtag.mgg',
        'sample-qmc-stag.mgg',
        'sample-qmc1.qmcflac',
      ].sort(),
    );
  });

  it('每个样本文件都存在且 sha256 与 manifest 一致', () => {
    for (const entry of manifest) {
      const file = path.join(FIXTURE_DIR, entry.file);
      expect(existsSync(file), `缺少 fixture：${entry.file}`).toBe(true);
      const bytes = readFixture(entry.file);
      expect(bytes.length, `${entry.file} 长度`).toBe(entry.size);
      expect(sha256(bytes), `${entry.file} 的 sha256 被改动过`).toBe(entry.fileSha256);
    }
  });

  it('需要 ekey 的样本都附带 ekey.txt，且内容非空', () => {
    const needKey = manifest.filter((m) => m.needsEkey);
    expect(needKey.map((m) => m.file).sort()).toEqual(
      ['sample-qmc-musicex.mflac', 'sample-qmc-stag.mgg'].sort(),
    );
    for (const entry of needKey) {
      expect(entry.ekeyFile, `${entry.file} 缺少 ekeyFile 字段`).toBeTruthy();
      const ekey = ekeyOf(entry);
      expect(ekey && ekey.length > 20, `${entry.ekeyFile} 内容为空`).toBe(true);
    }
  });
});

describe('fixtures: decryptFile 端到端', () => {
  for (const entry of manifest) {
    it(`${entry.file} → ok / ${entry.cipher} / ${entry.ext}，且明文 sha256 与清单一致`, () => {
      const out = decryptFile(readFixture(entry.file), {
        fileName: entry.file,
        ekey: ekeyOf(entry),
      });
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') return;
      expect(out.cipher).toBe(entry.cipher);
      expect(out.ext).toBe(entry.ext);
      expect(out.data.length, '明文长度必须与清单一致').toBe(entry.plaintextSize);
      expect(sha256(out.data), '下载得到的字节与清单 sha256 不匹配').toBe(entry.sha256);
      // 所有样本共用同一段假音频，明文应彼此完全一致
      expect(bytesToHex(out.data)).toBe(bytesToHex(readFixture('sample-plain.flac')));
    });
  }

  it('MusicEx / STag 缺少 ekey 时返回 need-key（而不是坏数据）', () => {
    for (const name of ['sample-qmc-musicex.mflac', 'sample-qmc-stag.mgg']) {
      const out = decryptFile(readFixture(name), { fileName: name });
      expect(out.status, `${name} 无 ekey 时应 need-key`).toBe('need-key');
    }
  });

  it('need-key 的定位信息足以让 UI 找回密钥', () => {
    const music = decryptFile(readFixture('sample-qmc-musicex.mflac'), {
      fileName: 'sample-qmc-musicex.mflac',
    });
    expect(music.status).toBe('need-key');
    if (music.status !== 'need-key') return;
    expect(music.info.mediaFilename).toBeTruthy();
    expect(music.info.mid).toBeTruthy();

    const stag = decryptFile(readFixture('sample-qmc-stag.mgg'), { fileName: 'sample-qmc-stag.mgg' });
    expect(stag.status).toBe('need-key');
    if (stag.status !== 'need-key') return;
    expect(stag.info.mid).toBeTruthy();
    expect(stag.info.resourceId).toBeTruthy();
  });

  it('NCM 样本的内嵌封面与元数据都能读出', () => {
    const out = decryptFile(readFixture('sample-ncm.ncm'));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cover?.mime).toBe('image/jpeg');
    expect(out.cover?.data.length).toBeGreaterThan(0);
    expect(out.meta?.title).toBe('合成样本曲目');
    expect(out.meta?.artist).toBe('测试歌手');
  });

  it('QTag 样本无需任何输入即可解密（内嵌 ekey）', () => {
    const out = decryptFile(readFixture('sample-qmc-qtag.mgg'));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cipher).toBe('QMC2/Map');
  });
});

describe('fixtures: 错误密钥与损坏输入', () => {
  it('把 ekey 末位改掉 → bad-key，不返回 ok', () => {
    const entry = manifest.find((m) => m.file === 'sample-qmc-musicex.mflac');
    expect(entry).toBeTruthy();
    if (!entry) return;
    const good = ekeyOf(entry) as string;
    const bad = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
    const out = decryptFile(readFixture(entry.file), { ekey: bad });
    expect(out.status, '错误 ekey 绝不能返回 ok').not.toBe('ok');
    expect(['bad-key', 'unsupported']).toContain(out.status);
  });

  it('NCM 的 CRC 字段被改坏 → 仍然 ok，但带 warning', () => {
    const bytes = readFixture('sample-ncm.ncm');
    // 定位 CRC：magic(8) + version(2) + keyLen + key + metaLen + meta
    const keyLen = readU32LE(bytes, 10);
    const metaLenPos = 14 + keyLen;
    const metaLen = readU32LE(bytes, metaLenPos);
    const crcPos = metaLenPos + 4 + metaLen;
    const broken = bytes.slice();
    broken[crcPos] ^= 0xff;
    const out = decryptFile(broken);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.warnings.some((w) => w.includes('CRC'))).toBe(true);
    expect(sha256(out.data)).toBe(manifest.find((m) => m.file === 'sample-ncm.ncm')?.sha256);
  });

  it('截断的 NCM（只剩头） → unsupported，而不是崩溃', () => {
    const bytes = readFixture('sample-ncm.ncm').slice(0, 64);
    const out = decryptFile(bytes);
    expect(out.status).toBe('unsupported');
  });

  it('纯随机 4 KiB → unsupported', () => {
    const noise = new Uint8Array(4096);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 91 + 17) & 0xff;
    expect(decryptFile(noise).status).toBe('unsupported');
  });

  it('空文件 → unsupported「文件为空」', () => {
    const out = decryptFile(new Uint8Array(0));
    expect(out.status).toBe('unsupported');
    if (out.status !== 'unsupported') return;
    expect(out.reason).toContain('文件为空');
  });
});

describe('交叉验证: AES-128-ECB 与 Node crypto 一致', () => {
  const keyBytes = latin1Encode('hzHRAmso5kInbaxW');

  for (const len of [1, 15, 16, 17, 64]) {
    it(`明文长度 ${len}：PKCS#7 密文与 node:crypto 逐字节一致`, () => {
      const plain = new Uint8Array(len);
      for (let i = 0; i < len; i++) plain[i] = (i * 37 + 9) & 0xff;
      expect(bytesToHex(aes128EcbEncryptPkcs7(plain, keyBytes))).toBe(nodeAesEcb(plain, keyBytes));
    });
  }

  it('node:crypto 加密的密文能被我们的解密还原', () => {
    const plainText = 'netease-cloud-music';
    const cipher = nodeAesEcb(latin1Encode(plainText), keyBytes);
    const plain = aes128EcbDecryptPkcs7(new Uint8Array(Buffer.from(cipher, 'hex')), keyBytes);
    expect(latin1Decode(plain)).toBe(plainText);
  });

  it('NCM metadata 密钥（含反斜杠的那个）也能被 node:crypto 复现', () => {
    const metaKey = latin1Encode(NCM_METADATA_KEY);
    expect(metaKey.length, 'metadata 密钥必须是 16 字节').toBe(16);
    expect(metaKey[8], '第 9 字节是反斜杠 0x5C').toBe(0x5c);
    const plain = new Uint8Array(32).fill(0x5a);
    expect(bytesToHex(aes128EcbEncryptPkcs7(plain, metaKey))).toBe(nodeAesEcb(plain, metaKey));
  });
});
