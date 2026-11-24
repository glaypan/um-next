/**
 * 生成合成样本文件（不是真实版权内容，仅用于本地验证解密链路）。
 *
 * 运行：node scripts/make-samples.mjs
 * 输出：`.tmp/samples/*`，并在控制台打印配套的 ekey。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aes128EcbEncryptPkcs7 } from '../src/core/aes128';
import {
  base64Encode,
  concatBytes,
  crc32,
  latin1Encode,
  writeU32BE,
  writeU32LE,
} from '../src/core/bytes';
import { decryptQMC1 } from '../src/core/qmc/qmc1';
import { createQmc2Cipher } from '../src/core/qmc/qmc2';
import { decryptEkey } from '../src/core/qmc/ekey';
import { buildNcmKeyStream, NCM_METADATA_KEY } from '../src/core/ncm/index';

/** 与 selfcheck 里一致的 ekey v1 向量：解出的 key 长 39 字节 → 走 Map 路径。 */
export const SAMPLE_EKEY =
  'MTIzNDU2NzhN2csrbjHfIPH0BrVByijvtaAXJdb4Iy7P/ktYG6Wxly+Vz5sZ5nqDPUHoVBuuzSQ=';

const outDir = path.resolve('.tmp/samples');
mkdirSync(outDir, { recursive: true });

/** 生成一段假的 FLAC：合法魔数 + 可预测的填充。 */
function makeFakeAudio(size = 4096): Uint8Array {
  const audio = new Uint8Array(size);
  audio.set(latin1Encode('fLaC'), 0);
  for (let i = 4; i < size; i++) audio[i] = (i * 31 + 7) & 0xff;
  return audio;
}

const audio = makeFakeAudio();

// 1) QMC1
{
  const enc = audio.slice();
  decryptQMC1(enc, 0); // XOR 对称
  writeFileSync(path.join(outDir, 'qmc1-sample.qmcflac'), enc);
}

// 2) QMC2 + MusicEx 尾部（无 ekey）
{
  const key = decryptEkey(SAMPLE_EKEY);
  const cipher = createQmc2Cipher(key);
  const enc = audio.slice();
  cipher.decrypt(enc, 0);

  const struct = new Uint8Array(0xb0);
  const mid = latin1Encode('001y7CaR29k6YP');
  for (let i = 0; i < mid.length; i++) struct[12 + i * 2] = mid[i];
  const mediaFilename = latin1Encode('F0M000112233445566.mflac');
  for (let i = 0; i < mediaFilename.length; i++) struct[72 + i * 2] = mediaFilename[i];
  const trailer = new Uint8Array(8);
  writeU32LE(trailer, 0, 0xc0);
  writeU32LE(trailer, 4, 1);
  const file = concatBytes(enc, struct, trailer, latin1Encode('musicex\0'));
  writeFileSync(path.join(outDir, 'musicex-sample.mflac'), file);
}

// 3) QMC2 + STag 尾部（无 ekey）
{
  const key = decryptEkey(SAMPLE_EKEY);
  const cipher = createQmc2Cipher(key);
  const enc = audio.slice();
  cipher.decrypt(enc, 0);
  const csv = latin1Encode('5177785,2,001y7CaR29k6YP');
  const len = new Uint8Array(4);
  writeU32BE(len, 0, csv.length);
  writeFileSync(path.join(outDir, 'stag-sample.mgg'), concatBytes(enc, csv, len, latin1Encode('STag')));
}

// 4) QMC2 + QTag 尾部（内嵌 ekey，可自动解密）
{
  const key = decryptEkey(SAMPLE_EKEY);
  const cipher = createQmc2Cipher(key);
  const enc = audio.slice();
  cipher.decrypt(enc, 0);
  const csv = latin1Encode(`${SAMPLE_EKEY},326454301,2`);
  const len = new Uint8Array(4);
  writeU32BE(len, 0, csv.length);
  writeFileSync(path.join(outDir, 'qtag-sample.mgg'), concatBytes(enc, csv, len, latin1Encode('QTag')));
}

// 5) NCM（含封面 + metadata）
{
  const contentKey = latin1Encode('0123456789abcdefKEY-KEY-KEY-KEY-KEY-');
  const encContent = aes128EcbEncryptPkcs7(
    concatBytes(latin1Encode('neteasecloudmusic'), contentKey),
    'hzHRAmso5kInbaxW',
  );
  const xoredContent = encContent.map((b) => b ^ 0x64);

  const metaJson =
    'music:' +
    JSON.stringify({
      musicId: 491320,
      musicName: '合成样本曲目',
      artist: [['测试歌手', 15105]],
      album: '合成样本专辑',
      format: 'flac',
      bitrate: 999000,
      duration: 123456,
    });
  const encMetaRaw = aes128EcbEncryptPkcs7(new TextEncoder().encode(metaJson), NCM_METADATA_KEY);
  const metaText = "163 key(Don't modify):" + base64Encode(encMetaRaw);
  const encMeta = latin1Encode(metaText).map((b) => b ^ 0x63);

  const u32 = (value: number): Uint8Array => {
    const b = new Uint8Array(4);
    writeU32LE(b, 0, value);
    return b;
  };

  const header = concatBytes(
    latin1Encode('CTENFDAM'),
    Uint8Array.from([1, 1]),
    u32(xoredContent.length),
    xoredContent,
    u32(encMeta.length),
    encMeta,
  );
  const crc = u32(crc32(header));

  // 一张极小的假 JPEG 封面
  const cover = concatBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), new Uint8Array(60).fill(0x11), Uint8Array.from([0xff, 0xd9]));
  const coverHeader = concatBytes(Uint8Array.from([1]), u32(cover.length), u32(cover.length));

  const ks = buildNcmKeyStream(contentKey);
  const encAudio = audio.map((b, i) => b ^ ks[i & 0xff]);

  writeFileSync(
    path.join(outDir, 'ncm-sample.ncm'),
    concatBytes(header, crc, coverHeader, cover, encAudio),
  );
}

// 6) 明文音频
writeFileSync(path.join(outDir, 'plain-sample.flac'), audio);

console.log(`样本已生成：${outDir}`);
console.log(`配套 ekey（MusicEx / STag 用）：\n${SAMPLE_EKEY}`);
console.log(`明文音频参考长度：${audio.length} 字节（首字节序列 fLaC）`);

// 7) QMC2 + QTag 尾部，但内容是真正的 OGG Vorbis（用于验证自动转 MP3）
{
  const ogg = new Uint8Array(readFileSync(path.resolve('tests/fixtures/sample-tone.ogg')));
  const key = decryptEkey(SAMPLE_EKEY);
  const cipher = createQmc2Cipher(key);
  const enc = ogg.slice();
  cipher.decrypt(enc, 0);
  const csv = latin1Encode(`${SAMPLE_EKEY},326454302,2`);
  const len = new Uint8Array(4);
  writeU32BE(len, 0, csv.length);
  writeFileSync(path.join(outDir, 'qtag-ogg.mgg'), concatBytes(enc, csv, len, latin1Encode('QTag')));
  writeFileSync(path.join(outDir, 'plain-ogg.ogg'), ogg);
}
