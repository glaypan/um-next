import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptEkey } from '../qmc/ekey';
import { createQmc2Cipher } from '../qmc/qmc2';
import {
  buildScannedKey,
  decodeEkeyCandidate,
  extractEkeyCandidates,
  findKeyForHeader,
  keyMatchesHeader,
  looksLikeEkeyShape,
} from '../ekeyScan';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/fixtures', name)));
}

const EKEY = new TextDecoder().decode(fixture('sample-qmc-musicex.ekey.txt')).trim();

function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    out[i * 2] = text.charCodeAt(i) & 0xff;
    out[i * 2 + 1] = text.charCodeAt(i) >>> 8;
  }
  return out;
}

describe('ekeyScan / 候选提取', () => {
  it('从纯文本的噪声里提取 ekey', () => {
    const text = `notes:\nfoo=bar\nsong.mflac,${EKEY}\nrandom=AAAA\n`;
    const candidates = extractEkeyCandidates(new TextEncoder().encode(text));
    expect(candidates).toContain(EKEY);
  });

  it('从 UTF-16LE 存储里提取（SQLite/MMKV 常见）', () => {
    const candidates = extractEkeyCandidates(utf16le(`mid=001y7CaR29k6YP\nkey=${EKEY}\n`));
    expect(candidates).toContain(EKEY);
  });

  it('从含大量二进制/空字节的缓冲区里提取', () => {
    const noise = new Uint8Array(4096);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) & 0xff;
    const tail = new TextEncoder().encode(`\n${EKEY}\n`);
    const merged = new Uint8Array(noise.length + tail.length);
    merged.set(noise);
    merged.set(tail, noise.length);
    expect(extractEkeyCandidates(merged)).toContain(EKEY);
  });

  it('明文前缀形式（QQMusic EncV2,Key:）也能被提取', () => {
    const plain = `QQMusic EncV2,Key:${'A'.repeat(64)}`;
    const candidates = extractEkeyCandidates(new TextEncoder().encode(plain));
    expect(candidates).toContain(plain);
    expect(looksLikeEkeyShape(plain)).toBe(true);
  });

  it('形状预筛拒绝过短/非法长度，避免把随机串送去解密', () => {
    expect(looksLikeEkeyShape('AAAA')).toBe(false);
    expect(looksLikeEkeyShape('A'.repeat(21))).toBe(false); // 21 % 4 === 1
    expect(looksLikeEkeyShape(EKEY)).toBe(true);
  });
});

describe('ekeyScan / 自证', () => {
  it('有效 ekey 能解出与内核一致的密钥', () => {
    const key = decodeEkeyCandidate(EKEY);
    expect(key).not.toBeNull();
    expect(Array.from(key!)).toEqual(Array.from(decryptEkey(EKEY)));
  });

  it('随机 base64 不会被当成 ekey', () => {
    let accepted = 0;
    for (let i = 0; i < 200; i++) {
      const random = Array.from({ length: 76 }, () => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        return alphabet[Math.floor(Math.random() * alphabet.length)];
      }).join('');
      if (decodeEkeyCandidate(random)) accepted += 1;
    }
    expect(accepted).toBe(0);
  });
});

describe('ekeyScan / 与文件配对', () => {
  const musicex = fixture('sample-qmc-musicex.mflac');
  const stag = fixture('sample-qmc-stag.mgg');

  it('正确密钥能解开 MusicEx 文件头', () => {
    const scanned = buildScannedKey(EKEY)!;
    expect(scanned).not.toBeNull();
    expect(keyMatchesHeader(scanned.cipher, musicex.subarray(0, 4096))).toBe(true);
  });

  it('同一密钥也能解开 STag 文件头', () => {
    const scanned = buildScannedKey(EKEY)!;
    expect(keyMatchesHeader(scanned.cipher, stag.subarray(0, 4096))).toBe(true);
  });

  it('错误密钥解不出音频魔数', () => {
    const key = decodeEkeyCandidate(EKEY)!;
    const wrong = new Uint8Array(key);
    wrong[0] ^= 0xff; // 破坏 8 字节 header，压缩后的 Map 密钥随之改变
    const cipher = createQmc2Cipher(wrong);
    expect(keyMatchesHeader(cipher, musicex.subarray(0, 4096))).toBe(false);
  });

  it('findKeyForHeader 能从混合数据里定位到正确密钥', () => {
    const blob = new Uint8Array(8192);
    const encoded = new TextEncoder().encode(`db:${EKEY}:end`);
    blob.set(encoded, 1000);
    const found = findKeyForHeader(blob, musicex.subarray(0, 4096));
    expect(found).toBe(EKEY);
  });

  it('没有密钥的缓冲区返回 null', () => {
    const blob = new Uint8Array(4096).fill(0x41);
    expect(findKeyForHeader(blob, musicex.subarray(0, 4096))).toBeNull();
  });
});
