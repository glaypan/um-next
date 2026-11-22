/**
 * 内核自检（不是正式单元测试；正式测试由 Tess 用 vitest 编写）。
 *
 * 覆盖：调查报告 §4 的已知向量 + 我自己构造的合成样本端到端。
 * 任何人改内核都可以 `npm run selfcheck` 快速回归，避免把算法改坏。
 */
import {
  base64Decode,
  base64Encode,
  bytesToHex,
  concatBytes,
  crc32,
  hexToBytes,
  latin1Decode,
  latin1Encode,
  writeU32BE,
  writeU32LE,
} from '../src/core/bytes';
import { aes128EcbDecryptPkcs7, aes128EcbEncryptPkcs7 } from '../src/core/aes128';
import { tcTeaCbcDecrypt, tcTeaCbcEncrypt } from '../src/core/tea';
import { V1_STATIC_KEY, decryptQMC1, decryptQMC1WithKey } from '../src/core/qmc/qmc1';
import {
  QmcRc4,
  buildRc4KeyStream,
  compressKey,
  createQmc2Cipher,
  decryptQMC2Rc4,
  getSegmentKey,
  hashKey,
} from '../src/core/qmc/qmc2';
import { EKEY_SIMPLE_KEY, decryptEkey } from '../src/core/qmc/ekey';
import { parseQmcFooter } from '../src/core/qmc/footer';
import {
  NCM_METADATA_KEY,
  buildNcmKeyStream,
  decryptContentKey,
  decryptMetadata,
  hasNcmMagic,
  isNcm,
  parseNcm,
} from '../src/core/ncm/index';
import { keyInfoFromFooter } from '../src/core/qmc/index';
import { decryptFile, resolveEkeyFromVault } from '../src/core/detect';
import { toVaultSnapshot } from '../src/store/vault';
import { DecryptAbortError, DecryptWorkerClient } from '../src/worker/client';
import { guessAudioFormat, looksLikeAudio } from '../src/core/audio';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const same = String(actual) === String(expected);
  check(name, same, same ? undefined : `期望 ${String(expected)}，实际 ${String(actual)}`);
}

function eqHex(name: string, actual: Uint8Array, expectedHex: string): void {
  const got = bytesToHex(actual);
  check(name, got === expectedHex.toLowerCase(), `期望 ${expectedHex}，实际 ${got}`);
}

const ascii = (s: string): Uint8Array => latin1Encode(s);
const fromAscii = (b: Uint8Array): string => latin1Decode(b);

/* ------------------------------------------------------------------ */
/* 0. 基础工具                                                         */
/* ------------------------------------------------------------------ */
eq('crc32("123456789")', crc32(ascii('123456789')).toString(16), 'cbf43926');
eq('base64 padding 可省略', base64Encode(base64Decode('aGVsbG8gd29ybGQ')), 'aGVsbG8gd29ybGQ=');
eq('base64 往返', fromAscii(base64Decode(base64Encode(ascii('hello world')))), 'hello world');
eq('SIMPLE_KEY', bytesToHex(EKEY_SIMPLE_KEY), '695646382b20150b');

/* AES-128 FIPS-197 附录 C 向量（分组级） */
{
  const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
  const plain = hexToBytes('00112233445566778899aabbccddeeff');
  const enc = aes128EcbEncryptPkcs7(plain, key);
  // 首个分组必须等于 FIPS-197 的期望密文
  eqHex('AES-128 FIPS-197 加密（首分组）', enc.subarray(0, 16), '69c4e0d86a7b0430d8cdb78070b4c55a');
  eqHex('AES-128 ECB+PKCS7 往返', aes128EcbDecryptPkcs7(enc, key), bytesToHex(plain));
}

/* ------------------------------------------------------------------ */
/* 1. QMC1                                                             */
/* ------------------------------------------------------------------ */
{
  const data = hexToBytes('ab2fbaa6ff47803daacd02');
  decryptQMC1(data, 0);
  eq('QMC1 静态密钥向量', fromAscii(data), 'hello world');
}
{
  const key = new Uint8Array(128);
  for (let i = 0; i < 128; i++) key[i] = i + 1;
  const a = hexToBytes('69676f686a2670677b666f');
  decryptQMC1WithKey(a, 0, key);
  eq('QMC1 key[i]=i+1 向量', fromAscii(a), 'hello world');

  const b = hexToBytes('1319111210a0756c766962');
  decryptQMC1WithKey(b, 32762, key);
  eq('QMC1 边界向量（offset 32762 起，跨 0x7FFF）', fromAscii(b), 'hello world');
}
{
  // offset === 0x7FFF 不回绕（只有 > 0x7FFF 才取模）
  const key = V1_STATIC_KEY;
  const idx = 0x7fff % 128;
  const value = key[idx] ^ 0x5a;
  const buf = Uint8Array.from([value]);
  decryptQMC1(buf, 0x7fff);
  eq('QMC1 offset=0x7FFF 不回绕', buf[0], 0x5a);
}

/* ------------------------------------------------------------------ */
/* 2. QMC2：key_compress / hash / segment_key / RC4                    */
/* ------------------------------------------------------------------ */
{
  const cycle = ascii('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const longKey = new Uint8Array(325);
  for (let i = 0; i < 325; i++) longKey[i] = cycle[i % cycle.length];
  eqHex(
    'key_compress(325 字节)',
    compressKey(longKey),
    '79f400759e3600148a6300b4be770017ba0037000000bf8041bf83ddbc5c0243148249020055be6dbf49808e4300fa4167a817f4ae161500c13782dd362138550079419e42c136facf35000041dd4342174d8e8add00bef538b4bf007acc4d0200cfc1c102a80016c1bfc242004900c1c2f5001741dc83c2009e41c171360080',
  );
  eq('hash("hello world")', hashKey(ascii('hello world')), 4045008896);
  eq('segmentKey(1,0,12345)', getSegmentKey(1, 0, 12345), 0);
  eq('segmentKey(1,123,12345)', getSegmentKey(1, 123, 12345), 5018);
  eq('segmentKey(51,35,516402887)', getSegmentKey(51, 35, 516402887), 28373784);
  eq('segmentKey(0,66,3908240000) > 2^32', getSegmentKey(0, 66, 3908240000), 5921575757);
}
{
  // RC4 变体：状态表长度 = key 长度(17)，直接取 PRGA 输出做 XOR（上游 rc4.rs 的用例）
  const key = ascii('this is a test key');
  const input = ascii('hello world');
  const rc4 = new QmcRc4(key);
  const out = input.slice();
  for (let i = 0; i < out.length; i++) out[i] ^= rc4.generate();
  eqHex('QMC2 RC4 核心向量', out, '68756b6464247f607c7d60');
}
{
  // 上游 256 字节整块向量：key 为 64 字符 cycle 的前 512 字节，解出应为 256 个 0
  const cycle = ascii('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const key = new Uint8Array(512);
  for (let i = 0; i < 512; i++) key[i] = cycle[i % cycle.length];
  const cipherHex =
    '395a4f753871376b3651536d7a66534b66506934676c337a5562355a32754f6844526d65756e3952307a686273593948555773325a7064504e526a634d3937767247644d626d586875473756696b4a79666370395934436b45325a313877704351796a62323365584a4d334e706262674c54786464776e7237415439425247321ae41b716829b36eadc52812d6a44b067adc901599d6bf72a230376b5cd62f35148ad6fb9fee7d2db737f20b6e00fba03c40f336b276200f9ea5a31560231529a191bffb1295aa8d92c60b8d4999a5e005cfb6ac07545828f996d19afe0b3cfb0b257a435a33c37afc33a3c26548298d2c8f4e88fd44fdd5cab98d624a48201d';
  const cipher = hexToBytes(cipherHex);
  eq('RC4 向量密文长度', cipher.length, 256);
  const hash = hashKey(key);
  const stream = buildRc4KeyStream(key);
  const whole = cipher.slice();
  decryptQMC2Rc4(whole, 0, key, hash, stream);
  check('QMC2 RC4 256 字节整块 → 全 0', whole.every((b) => b === 0), bytesToHex(whole.subarray(0, 16)));

  let chunkOk = true;
  for (const size of [1, 7, 333, 1024, 4096]) {
    const buf = cipher.slice();
    for (let pos = 0; pos < buf.length; pos += size) {
      decryptQMC2Rc4(buf.subarray(pos, Math.min(pos + size, buf.length)), pos, key, hash, stream);
    }
    if (!buf.every((b) => b === 0)) chunkOk = false;
  }
  check('QMC2 RC4 分块一致性（1/7/333/1024/4096）', chunkOk);
}

/* ------------------------------------------------------------------ */
/* 3. tc_tea 官方向量                                                  */
/* ------------------------------------------------------------------ */
{
  const key = ascii('12345678ABCDEFGH');
  const cipher = hexToBytes('91095162e3f5b6dc6b414b50d1a5b84ec50d0c1b1196fd3c');
  const plain = tcTeaCbcDecrypt(cipher, key);
  eqHex('tc_tea CBC 官方向量', plain, '0102030405060708');
  const again = tcTeaCbcEncrypt(plain, key, Uint8Array.from([0x2e, 0x23]));
  eqHex('tc_tea 往返（自实现加密）', tcTeaCbcDecrypt(again, key), '0102030405060708');
}

/* ------------------------------------------------------------------ */
/* 4. ekey v1 / v2                                                     */
/* ------------------------------------------------------------------ */
const EKEY_V1 =
  'MTIzNDU2NzhN2csrbjHfIPH0BrVByijvtaAXJdb4Iy7P/ktYG6Wxly+Vz5sZ5nqDPUHoVBuuzSQ=';
const EKEY_V2 =
  'UVFNdXNpYyBFbmNWMixLZXk6d/S8i//PVeRowyovUFz1jJ+6VbOYnLZj1Mp5JLj2rEfhiMvu1tfCQoqMDhvElejO55orRpPw46vw568GCNAPOggejJzfgaK9TXJ9LEbK4KvQh8T7d6nBhelG8gIgpP9g1Cm8y4mPemQ=';
const EKEY_EXPECTED =
  '3132333435363738716d63322d6d61702d6b65792d6d6174657269616c2d333262797465732121';
{
  eqHex('ekey v1 → key', decryptEkey(EKEY_V1), EKEY_EXPECTED);
  eqHex('ekey v2（两次 TEA）→ key', decryptEkey(EKEY_V2), EKEY_EXPECTED);
  eq('ekey 长度 = 39（Map 路径）', decryptEkey(EKEY_V1).length, 39);
  let threw = false;
  try {
    decryptEkey('这不是ekey');
  } catch {
    threw = true;
  }
  check('非法 ekey 抛错', threw);
}

/* ------------------------------------------------------------------ */
/* 5. 尾部解析                                                         */
/* ------------------------------------------------------------------ */
{
  // STag: CSV(resourceId,2,mediaMid) + BE u32 payloadLen + "STag"
  const csv = ascii('5177785,2,001y7CaR29k6YP');
  const lenBytes = new Uint8Array(4);
  writeU32BE(lenBytes, 0, csv.length);
  const stag = concatBytes(csv, lenBytes, ascii('STag'));
  const parsed = parseQmcFooter(stag);
  check('STag 识别', parsed?.kind === 'stag');
  eq('STag size', parsed?.kind === 'stag' ? parsed.size : -1, 0x20);
  eq('STag mediaMid', parsed?.kind === 'stag' ? parsed.mediaMid : '', '001y7CaR29k6YP');

  // QTag: CSV(ekey,resourceId,2)
  const qcsv = ascii('00112233aBcD+/=,326454301,2');
  const qlen = new Uint8Array(4);
  writeU32BE(qlen, 0, qcsv.length);
  const qtag = concatBytes(qcsv, qlen, ascii('QTag'));
  const qparsed = parseQmcFooter(qtag);
  check('QTag 识别', qparsed?.kind === 'qtag');
  eq('QTag size', qparsed?.kind === 'qtag' ? qparsed.size : -1, 0x23);

  // MusicEx
  const struct = new Uint8Array(0xb0);
  const mid = ascii('AaBbCcDdEeFfGg');
  for (let i = 0; i < mid.length; i++) struct[12 + i * 2] = mid[i];
  const filename = ascii('F0M000112233445566.mflac');
  for (let i = 0; i < filename.length; i++) struct[72 + i * 2] = filename[i];
  const tail = new Uint8Array(8);
  writeU32LE(tail, 0, 0xc0);
  writeU32LE(tail, 4, 1);
  const musicex = concatBytes(struct, tail, ascii('musicex\0'));
  eq('MusicEx 总长', musicex.length, 0xc0);
  const mparsed = parseQmcFooter(musicex);
  check('MusicEx 识别', mparsed?.kind === 'musicex');
  eq('MusicEx mid', mparsed?.kind === 'musicex' ? mparsed.mid : '', 'AaBbCcDdEeFfGg');
  eq(
    'MusicEx mediaFilename',
    mparsed?.kind === 'musicex' ? mparsed.mediaFilename : '',
    'F0M000112233445566.mflac',
  );

  // PCv1Legacy
  const payloadLen = 0x2c0;
  const payload = new Uint8Array(payloadLen);
  payload.set(ascii(EKEY_V1), 0);
  const plen = new Uint8Array(4);
  writeU32LE(plen, 0, payloadLen);
  const pcv1 = concatBytes(payload, plen);
  const pparsed = parseQmcFooter(pcv1);
  check('PCv1Legacy 识别', pparsed?.kind === 'pcv1');
  eq('PCv1Legacy size', pparsed?.kind === 'pcv1' ? pparsed.size : -1, 0x2c4);
  eq('PCv1Legacy ekey', pparsed?.kind === 'pcv1' ? pparsed.ekey : '', EKEY_V1);

  check('随机数据不误判尾部', parseQmcFooter(new Uint8Array(64).fill(0x41)) === null);
}

/* ------------------------------------------------------------------ */
/* 6. NCM：content key / keystream / metadata / 合成整文件              */
/* ------------------------------------------------------------------ */
{
  const encKeyHex =
    '2cced5eb69eafb14550d45bf61dd171d9371471ee1dddaf4d5e84f1cba0020c302e9fe2992e181456f18c72d11f2bc5bbcdc2233f968b4b028383f636c886635f9e7b1700eee55acb8ed8b4817253ae65eb580788acddce1ef3d30ec9c2ac6c751ae3d11b564889ed67766f62b529efaf963f6de27104582ac2d2084954c0f7aae8b916d102e631ceacaf91497d8b3e8';
  const contentKey = decryptContentKey(hexToBytes(encKeyHex));
  eq('NCM content key 长度', contentKey.length, 114);
  check(
    'NCM content key 内容',
    fromAscii(contentKey) ===
      '174279197715752960061821572626E7fT49x7dof9OKCgg9cdvhEuezy3iZCL1nFvBFd1T4uSktAJKmwZXsijPbijliionVUXXg9plTbXEclAE9Lb',
    fromAscii(contentKey).slice(0, 32),
  );

  const ks = buildNcmKeyStream(contentKey);
  eq('NCM keystream 头 16 字节', bytesToHex(ks.subarray(0, 16)), '6720f05cacaf1b740d2640be8561450d');
  eq(
    'NCM keystream 尾 16 字节',
    bytesToHex(ks.subarray(240, 256)),
    'cdba97dea33b67d40bf4d39725baca08',
  );

  const metaHex =
    '5255504308061a4b270c0d4417430e0c070a051a4a592f555725365034573a1b3b503925370e0139485b4c0509072b5522004831324c17070d241a3911265a15292450020720562d335a0c10292622284c1a0d0b06280d2c1b092e0b2b2802130f2f2c0e251b4c2b52333609372d0b25272c0c0d0251355a1a352d2f3b542a0d4c2b161b0c26210b522552365b515056010a19145b573207065025555453302c32521500503739280e150f36481124335607222029142806160154480b172025360201160727160c37202a24212250560e3452371429103220362d522102093b0b01170033360d01212b174c39023351022007374c5a253909512550544c193237080632551b530b0b4c081633542711021a30285725503b2e2834513b361153125609212b2c142d245a0253162129160253022a312d31563b1751520f5650560017572f081a5225122d480502370f363005145a375a50551609533b1b241a1a215006372e5709391713263104525055105352570204022f015a022a2f194c0c5500502d29061611200d015322321b34000a0602150f255a1a22110e2132312239565a0916351630290f30272c55521248160f0c360c252728350a1a060916391b081027122c2c5b48014833480e1b541b0236252048310b060d151117012420273130220f2208170f130c0c1a1212514c3b533b37391625055410320d480c505b200b1922190d0b282c0b053b5109540a060f570851502429165733361504505b2f515612092f2730512b375724355b0c0e0d0d532a2506332229512408513a060e1631362b103430080a2f19325a043952361a26140e0b2a4c39561a012f14333356162529330e0b2d1a11290815022b4c010c070f154c3636094c1353111112020f11562b5b21290b5109023b1102241612040a370b225a0b020a0236362a291a1414131b2c11312a4c28112b1b30513511530d090f390f2517025b1a39265b513b2e042e2136043b11560a2e2d1a27211007531137072f51572b2457015335520f2f2d4852562b00171a39001209020702522c204c394c48500d0f154c002b0f37481917323531280b0d2d3210325633283b2b5512040750240008011026302c3410210d25022e53112b1936312e5a523335201453300405083413025422055a01201314392a251b374857532a223a0034532412';
  const meta = decryptMetadata(hexToBytes(metaHex));
  eq('NCM metadata musicId', meta.musicId, 491320);
  eq('NCM metadata format', meta.format, 'mp3');
  check('NCM metadata 标题含柯南', String(meta.musicName).includes('名探侦コナン'));
}

/* -------- 合成 NCM 整文件：覆盖 CRC 覆盖范围 / 偏移 / 封面缺失 -------- */
let sampleNcm: Uint8Array | null = null;
{
  const contentKey = ascii('0123456789abcdefKEY-KEY-KEY-KEY-KEY-');
  const audio = concatBytes(ascii('fLaC'), new Uint8Array(200).fill(0x5a));

  const encContent = aes128EcbEncryptPkcs7(concatBytes(ascii('neteasecloudmusic'), contentKey), 'hzHRAmso5kInbaxW');
  const xoredContent = new Uint8Array(encContent.length);
  for (let i = 0; i < encContent.length; i++) xoredContent[i] = encContent[i] ^ 0x64;

  const metaJson =
    'music:' +
    JSON.stringify({
      musicId: 1,
      musicName: '测试曲目',
      artist: [['测试歌手', 1]],
      album: '测试专辑',
      format: 'flac',
      bitrate: 999000,
      duration: 12345,
    });
  const utf8Meta = new TextEncoder().encode(metaJson);
  const encMetaRaw = aes128EcbEncryptPkcs7(utf8Meta, NCM_METADATA_KEY);
  const metaText = "163 key(Don't modify):" + base64Encode(encMetaRaw);
  const encMeta = new Uint8Array(metaText.length);
  for (let i = 0; i < metaText.length; i++) encMeta[i] = metaText.charCodeAt(i) ^ 0x63;

  const header = concatBytes(
    ascii('CTENFDAM'),
    Uint8Array.from([1, 1]),
    (() => {
      const b = new Uint8Array(4);
      writeU32LE(b, 0, xoredContent.length);
      return b;
    })(),
    xoredContent,
    (() => {
      const b = new Uint8Array(4);
      writeU32LE(b, 0, encMeta.length);
      return b;
    })(),
    encMeta,
  );
  const crcBytes = new Uint8Array(4);
  writeU32LE(crcBytes, 0, crc32(header));

  // 封面：frameLen = 0 表示 3.x 无封面
  const coverHeader = new Uint8Array(9);
  coverHeader[0] = 1;
  writeU32LE(coverHeader, 1, 0);
  writeU32LE(coverHeader, 5, 0);

  // 音频流用 keystream 加密（XOR 对称）
  const ks = buildNcmKeyStream(contentKey);
  const encAudio = audio.slice();
  for (let i = 0; i < encAudio.length; i++) encAudio[i] ^= ks[i & 0xff];

  const ncm = concatBytes(header, crcBytes, coverHeader, encAudio);
  const parsed = parseNcm(ncm.slice());
  eqHex('合成 NCM 音频还原', parsed.data, bytesToHex(audio));
  eq('合成 NCM 标题', parsed.meta?.title, '测试曲目');
  eq('合成 NCM 艺术家', parsed.meta?.artist, '测试歌手');
  eq('合成 NCM 无封面（3.x）', parsed.cover, undefined);
  eq('合成 NCM 无 warning', parsed.warnings.length, 0);

  // CRC 不匹配 → 仅告警，继续解密（3.x 容错）
  const badNcm = ncm.slice();
  const crcPos = header.length;
  badNcm[crcPos] ^= 0xff;
  const withBadCrc = parseNcm(badNcm);
  eqHex('CRC 不匹配仍能解出音频', withBadCrc.data, bytesToHex(audio));
  check('CRC 不匹配产生 warning', withBadCrc.warnings.some((w) => w.includes('CRC')), withBadCrc.warnings.join(';'));

  sampleNcm = ncm;

  const outcome = decryptFile(ncm.slice(), { fileName: 'test.ncm' });
  check('decryptFile 识别合成 NCM', outcome.status === 'ok');
  eq('合成 NCM 扩展名', outcome.status === 'ok' ? outcome.ext : '', 'flac');
  eq('合成 NCM cipher', outcome.status === 'ok' ? outcome.cipher : '', 'NCM');
}

/* ------------------------------------------------------------------ */
/* 7. detect：QMC1 / QMC2-Map / MusicEx / STag / 错密钥                 */
/* ------------------------------------------------------------------ */
const fakeAudio = concatBytes(ascii('fLaC'), new Uint8Array(300).fill(0x33));

{
  // QMC1：XOR 对称
  const enc = fakeAudio.slice();
  decryptQMC1(enc, 0);
  check('QMC1 密文不再是音频', !looksLikeAudio(enc));
  const outcome = decryptFile(enc, { fileName: 'a.qmcflac' });
  check('detect 识别 QMC1', outcome.status === 'ok');
  eq('QMC1 输出 ext', outcome.status === 'ok' ? outcome.ext : '', 'flac');
  eq('QMC1 输出 cipher', outcome.status === 'ok' ? outcome.cipher : '', 'QMC1');
  eqHex('QMC1 输出内容', outcome.status === 'ok' ? outcome.data : new Uint8Array(), bytesToHex(fakeAudio));
}
{
  // QMC2-Map + MusicEx 尾部（无 ekey）→ need-key；带 vault → ok
  const key = decryptEkey(EKEY_V1);
  const cipher = createQmc2Cipher(key);
  const enc = fakeAudio.slice();
  cipher.decrypt(enc, 0);

  const struct = new Uint8Array(0xb0);
  const mid = ascii('001y7CaR29k6YP');
  for (let i = 0; i < mid.length; i++) struct[12 + i * 2] = mid[i];
  const fname = ascii('F0M000112233445566.mflac');
  for (let i = 0; i < fname.length; i++) struct[72 + i * 2] = fname[i];
  const trailer = new Uint8Array(8);
  writeU32LE(trailer, 0, 0xc0);
  writeU32LE(trailer, 4, 1);
  const file = concatBytes(enc, struct, trailer, ascii('musicex\0'));

  const need = decryptFile(file.slice(), { fileName: 'song.mflac' });
  check('MusicEx 无 ekey → need-key', need.status === 'need-key');
  eq(
    'need-key 的 mediaFilename',
    need.status === 'need-key' ? need.info.mediaFilename : '',
    'F0M000112233445566.mflac',
  );

  const viaEkey = decryptFile(file.slice(), { ekey: EKEY_V1 });
  check('MusicEx + 手输 ekey → ok', viaEkey.status === 'ok');
  eqHex(
    'MusicEx 解密内容',
    viaEkey.status === 'ok' ? viaEkey.data : new Uint8Array(),
    bytesToHex(fakeAudio),
  );
  eq('MusicEx 输出 cipher', viaEkey.status === 'ok' ? viaEkey.cipher : '', 'QMC2/Map');

  const viaVault = decryptFile(file.slice(), {
    fileName: 'song.mflac',
    vault: { byFilename: { 'F0M000112233445566.mflac': EKEY_V1 }, byMid: {}, byBasename: {} },
  });
  check('MusicEx + 保险库（mediaFilename）→ ok', viaVault.status === 'ok');

  const viaMid = decryptFile(file.slice(), {
    vault: { byFilename: {}, byMid: { '001y7CaR29k6YP': EKEY_V1 }, byBasename: {} },
  });
  check('MusicEx + 保险库（mid 回退）→ ok', viaMid.status === 'ok');

  const viaBasename = decryptFile(file.slice(), {
    fileName: 'C:\\Music\\song.mflac',
    vault: { byFilename: {}, byMid: {}, byBasename: { 'song.mflac': EKEY_V1 } },
  });
  check('MusicEx + 保险库（basename 回退）→ ok', viaBasename.status === 'ok');

  // 错密钥：结构合法但 key 不对
  const wrongKeyEkey = EKEY_V1;
  const need2 = decryptFile(file.slice(), { ekey: wrongKeyEkey.replace(/.$/, 'A') });
  check('损坏 ekey → bad-key（不静默成功）', need2.status === 'bad-key' || need2.status === 'unsupported');
}
{
  // STag：无 ekey，必须只靠用户密钥；内嵌 QTag/PCv1 可自动解
  const key = decryptEkey(EKEY_V1);
  const cipher = createQmc2Cipher(key);
  const enc = fakeAudio.slice();
  cipher.decrypt(enc, 0);
  const csv = ascii('5177785,2,001y7CaR29k6YP');
  const lenBytes = new Uint8Array(4);
  writeU32BE(lenBytes, 0, csv.length);
  const file = concatBytes(enc, csv, lenBytes, ascii('STag'));

  const need = decryptFile(file.slice(), { fileName: 'x.mgg' });
  check('STag 无 ekey → need-key', need.status === 'need-key');
  eq('STag need-key mid', need.status === 'need-key' ? need.info.mid : '', '001y7CaR29k6YP');
  const ok = decryptFile(file.slice(), { ekey: EKEY_V1 });
  check('STag + ekey → ok', ok.status === 'ok');
  eqHex('STag 解密内容', ok.status === 'ok' ? ok.data : new Uint8Array(), bytesToHex(fakeAudio));
}
{
  // QTag（内嵌 ekey，自动解密）
  const key = decryptEkey(EKEY_V1);
  const cipher = createQmc2Cipher(key);
  const enc = fakeAudio.slice();
  cipher.decrypt(enc, 0);
  const csv = ascii(`${EKEY_V1},326454301,2`);
  const lenBytes = new Uint8Array(4);
  writeU32BE(lenBytes, 0, csv.length);
  const file = concatBytes(enc, csv, lenBytes, ascii('QTag'));
  const outcome = decryptFile(file.slice(), { fileName: 'y.mgg' });
  check('QTag 自动解密 → ok', outcome.status === 'ok');
  eqHex('QTag 解密内容', outcome.status === 'ok' ? outcome.data : new Uint8Array(), bytesToHex(fakeAudio));
}
{
  // RC4 路径（长 key）+ PCv1 尾部
  const longKey = new Uint8Array(400);
  for (let i = 0; i < 400; i++) longKey[i] = (i * 7 + 3) & 0xff;
  const cipher = createQmc2Cipher(longKey);
  eq('长 key 走 RC4 路径', cipher.kind, 'rc4');
  const enc = fakeAudio.slice();
  cipher.decrypt(enc, 0);
  check('RC4 密文不是音频', !looksLikeAudio(enc));
  // 直接验证 decryptFile 的 QMC2/RC4 分支：用 PCv1 尾部（内嵌 ekey）+ 已知长 key
  // 这里用「伪造 ekey → 长 key」不可行，改为直接验证 cipher 的往返
  const round = enc.slice();
  cipher.decrypt(round, 0);
  eqHex('QMC2/RC4 往返一致', round, bytesToHex(fakeAudio));
}
{
  // 明文音频直接通过
  const outcome = decryptFile(fakeAudio.slice(), { fileName: 'plain.flac' });
  check('明文音频直接通过', outcome.status === 'ok');
  eq('明文音频 cipher', outcome.status === 'ok' ? outcome.cipher : '', 'AUDIO');
  eq('明文音频 ext', outcome.status === 'ok' ? outcome.ext : '', 'flac');
}
{
  const outcome = decryptFile(new Uint8Array(256).fill(0x7f), { fileName: 'x.bin' });
  check('垃圾数据 → unsupported', outcome.status === 'unsupported');
  const empty = decryptFile(new Uint8Array(0), {});
  check('空文件 → unsupported', empty.status === 'unsupported');
}

/* ------------------------------------------------------------------ */
/* 8. 复审修复：截断 NCM / MP3 误判 / 空标识回退                        */
/* ------------------------------------------------------------------ */
{
  /* (1) 截断的 NCM 要报「文件不完整」而不是「无法识别」 */
  check('hasNcmMagic 只看 8 字节，isNcm 要求 ≥10 字节', hasNcmMagic(ascii('CTENFDAM')) && !isNcm(ascii('CTENFDAM')));

  const onlyMagic = decryptFile(ascii('CTENFDAM'), { fileName: 'a.ncm' });
  check(
    '只有 magic（8 字节）的 NCM → 「文件头不完整（可能未下载完成）」',
    onlyMagic.status === 'unsupported' && onlyMagic.reason.includes('文件头不完整（可能未下载完成）'),
    onlyMagic.status === 'unsupported' ? onlyMagic.reason : onlyMagic.status,
  );

  const truncated = decryptFile((sampleNcm as Uint8Array).slice(0, 64));
  check(
    '截断到 64 字节的 NCM → 「文件头不完整」',
    truncated.status === 'unsupported' && truncated.reason.includes('文件头不完整（可能未下载完成）'),
    truncated.status === 'unsupported' ? truncated.reason : truncated.status,
  );

  const lenBroken = (sampleNcm as Uint8Array).slice();
  const hugeKeyLen = new Uint8Array(4);
  writeU32LE(hugeKeyLen, 0, 0x1000); // 远大于剩余字节
  lenBroken.set(hugeKeyLen, 10);
  const lenOutcome = decryptFile(lenBroken);
  check(
    'contentKeyLen 越界 → 归为「文件头不完整」且保留具体原因',
    lenOutcome.status === 'unsupported' &&
      lenOutcome.reason.includes('文件头不完整') &&
      lenOutcome.reason.includes('content key 长度非法'),
    lenOutcome.status === 'unsupported' ? lenOutcome.reason : lenOutcome.status,
  );

  const notNcm = decryptFile(concatBytes(ascii('CTENFDAX'), new Uint8Array(64)));
  check(
    '不是 NCM 的文件不会被误报「文件头不完整」',
    notNcm.status === 'unsupported' && !notNcm.reason.includes('文件头不完整'),
    notNcm.status === 'unsupported' ? notNcm.reason : notNcm.status,
  );
}

{
  /* (2) MP3 不再只看 2 字节 sync */
  const singleFrame = Uint8Array.from([0xff, 0xfb, 0x90, 0x00]); // MPEG1 L3 128kbps 44.1kHz
  eq('合法单帧头（数据不足一帧）→ mp3', guessAudioFormat(singleFrame)?.ext, 'mp3');

  const frameLen = 417; // 144 * 128000 / 44100
  const twoFrames = new Uint8Array(frameLen * 2);
  twoFrames.set(singleFrame, 0);
  twoFrames.set(singleFrame, frameLen);
  eq('连续两帧合法帧头 → mp3', guessAudioFormat(twoFrames)?.ext, 'mp3');

  const brokenSecond = twoFrames.slice();
  brokenSecond[frameLen] = 0x00;
  eq('第二帧帧头非法 → 不判 mp3', guessAudioFormat(brokenSecond), null);

  eq('version=reserved（0xFF 0xEB）→ 不判 mp3', guessAudioFormat(Uint8Array.from([0xff, 0xeb, 0xff, 0xff])), null);
  eq('bitrate=free(0)（0xFF 0xE2）→ 不判 mp3', guessAudioFormat(Uint8Array.from([0xff, 0xe2, 0x00, 0x00])), null);

  // 统计校验：1000 个以 0xFF 开头的随机 4 KiB 缓冲，一个都不该被判成音频
  let x = 0x2545f491;
  const nextByte = (): number => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x & 0xff;
  };
  let falsePositive = 0;
  for (let sample = 0; sample < 1000; sample++) {
    const buf = new Uint8Array(4096);
    buf[0] = 0xff;
    for (let i = 1; i < buf.length; i++) buf[i] = nextByte();
    if (looksLikeAudio(buf)) falsePositive++;
  }
  eq('1000 个随机 0xFF 开头缓冲 → 0 个误判为音频', falsePositive, 0);
}

{
  /* (3) MusicEx 双标识为空 → suggestedName / basename 回退 */
  const emptyStruct = new Uint8Array(0xb0); // mid 与 mediaFilename 全 0
  const trailer = new Uint8Array(8);
  writeU32LE(trailer, 0, 0xc0);
  writeU32LE(trailer, 4, 1);
  const emptyTail = concatBytes(emptyStruct, trailer, ascii('musicex '));

  const footer = parseQmcFooter(emptyTail);
  check('MusicEx 空标识仍能解析出尾部', footer?.kind === 'musicex');
  if (footer) {
    const info = keyInfoFromFooter(footer, 'D:////Music////夜曲.mflac');
    eq('空标识 → suggestedName 回退为去扩展名文件名', info.suggestedName, '夜曲');
    eq('空标识 → mid 为 undefined', info.mid, undefined);
    eq('空标识 → mediaFilename 为 undefined', info.mediaFilename, undefined);
  }

  const key = decryptEkey(EKEY_V1);
  const cipher = createQmc2Cipher(key);
  const enc = fakeAudio.slice();
  cipher.decrypt(enc, 0);
  const file = concatBytes(enc, emptyTail);

  const need = decryptFile(file.slice(), { fileName: 'D:////Music////夜曲.mflac' });
  check('空标识 MusicEx → need-key', need.status === 'need-key');
  eq('need-key 带 suggestedName', need.status === 'need-key' ? need.info.suggestedName : '', '夜曲');

  const viaBasename = decryptFile(file.slice(), {
    fileName: '夜曲.mflac',
    vault: { byFilename: {}, byMid: {}, byBasename: { 夜曲: EKEY_V1 } },
  });
  check('空标识 + 保险库 basename（去扩展名）命中 → ok', viaBasename.status === 'ok');
  eqHex(
    '空标识保险库命中的内容',
    viaBasename.status === 'ok' ? viaBasename.data : new Uint8Array(),
    bytesToHex(fakeAudio),
  );

  const noFileName = decryptFile(file.slice());
  check('完全没给文件名也不会崩（仍 need-key）', noFileName.status === 'need-key');
}

/* ------------------------------------------------------------------ */
/* 9. 审查修复：取消竞态 / keySource / 原型污染                         */
/* ------------------------------------------------------------------ */
{
  /* (1) 「arrayBuffer 还没读完就点取消」不能产生任何 Worker 消息 */

  /** 假的 Worker：只记录 postMessage，不真正跑线程。 */
  class FakeWorker {
    static instances: FakeWorker[] = [];
    posted: Array<{ type: string; id?: string }> = [];
    terminated = false;
    constructor() {
      FakeWorker.instances.push(this);
    }
    addEventListener(): void {
      /* 不需要 */
    }
    postMessage(message: { type: string }): void {
      this.posted.push(message);
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  const globalWithWorker = globalThis as unknown as { Worker: unknown };
  const originalWorker = globalWithWorker.Worker;
  globalWithWorker.Worker = FakeWorker;

  const client = new DecryptWorkerClient();
  let releaseRead: ((buffer: ArrayBuffer) => void) | undefined;
  const slowFile = {
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((resolve) => {
        releaseRead = resolve;
      }),
  } as unknown as Blob;

  const pendingResult = client.decrypt(slowFile, { fileName: 'slow.mflac' });
  check('读取文件期间 busy 为 true（占位生效）', client.busy);
  client.cancel();
  check('取消后 busy 立即为 false', !client.busy);

  releaseRead?.(new ArrayBuffer(32));
  let rejectedAsAbort = false;
  try {
    await pendingResult;
  } catch (err) {
    rejectedAsAbort = err instanceof DecryptAbortError;
  }
  check('读取完成后抛 DecryptAbortError（不是正常结果）', rejectedAsAbort);
  const postedAfterCancel = FakeWorker.instances.reduce((sum, w) => sum + w.posted.length, 0);
  eq('取消后不会把任务 post 给 Worker', postedAfterCancel, 0);

  // 取消后必须能正常接下一个任务（pending 已释放，不会撞「上一个任务尚未结束」）
  const quickFile = { arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
  const second = client.decrypt(quickFile, { fileName: 'next.mflac' });
  await Promise.resolve();
  await Promise.resolve();
  const postedAfterNext = FakeWorker.instances.reduce((sum, w) => sum + w.posted.length, 0);
  eq('取消后新任务仍可正常提交', postedAfterNext, 1);
  void second;
  client.dispose();
  globalWithWorker.Worker = originalWorker;
}

{
  /* (2) keySource 四条路径 */
  const key = decryptEkey(EKEY_V1);
  const cipher = createQmc2Cipher(key);
  const enc = fakeAudio.slice();
  cipher.decrypt(enc, 0);

  const struct = new Uint8Array(0xb0);
  const mid = ascii('001y7CaR29k6YP');
  for (let i = 0; i < mid.length; i++) struct[12 + i * 2] = mid[i];
  const trailer = new Uint8Array(8);
  writeU32LE(trailer, 0, 0xc0);
  writeU32LE(trailer, 4, 1);
  const needKeyFile = concatBytes(enc, struct, trailer, ascii('musicex\0'));

  const manual = decryptFile(needKeyFile.slice(), { ekey: EKEY_V1 });
  eq('手输 ekey → keySource=manual', manual.status === 'ok' ? manual.keySource : '', 'manual');

  const fromVault = decryptFile(needKeyFile.slice(), {
    // 该样本的 mediaFilename 为空、只有 mid，必须走 byMid 命中
    vault: { byFilename: {}, byMid: { '001y7CaR29k6YP': EKEY_V1 }, byBasename: {} },
  });
  eq('保险库命中 → keySource=vault', fromVault.status === 'ok' ? fromVault.keySource : '', 'vault');

  // QTag：内嵌 ekey
  const qcsv = ascii(`${EKEY_V1},326454301,2`);
  const qlen = new Uint8Array(4);
  writeU32BE(qlen, 0, qcsv.length);
  const qtagFile = concatBytes(enc, qcsv, qlen, ascii('QTag'));
  const embedded = decryptFile(qtagFile.slice(), { fileName: 'x.mgg' });
  eq('内嵌 ekey → keySource=embedded', embedded.status === 'ok' ? embedded.keySource : '', 'embedded');

  // 不需要密钥的三条路径
  const ncmOut = decryptFile((sampleNcm as Uint8Array).slice());
  eq('NCM → keySource=none', ncmOut.status === 'ok' ? ncmOut.keySource : '', 'none');
  const qmc1Enc = fakeAudio.slice();
  decryptQMC1(qmc1Enc, 0);
  const qmc1Out = decryptFile(qmc1Enc);
  eq('QMC1 → keySource=none', qmc1Out.status === 'ok' ? qmc1Out.keySource : '', 'none');
  const plainOut = decryptFile(fakeAudio.slice());
  eq('明文音频 → keySource=none', plainOut.status === 'ok' ? plainOut.keySource : '', 'none');
}

{
  /* (3) 原型链键不能当 ekey（constructor / toString / __proto__） */
  const key = decryptEkey(EKEY_V1);
  const cipher = createQmc2Cipher(key);
  const enc = fakeAudio.slice();
  cipher.decrypt(enc, 0);
  const struct = new Uint8Array(0xb0); // 双标识为空，靠 basename 回退
  const trailer = new Uint8Array(8);
  writeU32LE(trailer, 0, 0xc0);
  writeU32LE(trailer, 4, 1);
  const file = concatBytes(enc, struct, trailer, ascii('musicex\0'));

  const protoHit = decryptFile(file.slice(), {
    fileName: 'constructor',
    vault: { byFilename: {}, byMid: {}, byBasename: {} },
  });
  eq(
    "文件名 'constructor' 不会命中原型链（仍 need-key）",
    protoHit.status,
    'need-key',
  );

  const toStringHit = decryptFile(file.slice(), {
    fileName: 'toString.mflac',
    vault: { byFilename: {}, byMid: {}, byBasename: {} },
  });
  eq("文件名 'toString' 不会命中原型链", toStringHit.status, 'need-key');

  // 但保险库里真实存在同名自有键时必须命中（别把功能一起修掉）
  const ownKey = decryptFile(file.slice(), {
    fileName: 'constructor.mflac',
    vault: { byFilename: {}, byMid: {}, byBasename: { constructor: EKEY_V1 } },
  });
  eq("保险库中真实存在 'constructor' 键时仍能命中", ownKey.status, 'ok');

  // toVaultSnapshot 用 null 原型：危险键不会污染/丢失
  const snapshot = toVaultSnapshot({
    version: 1,
    entries: [
      { kind: 'basename', identifier: 'constructor', ekey: 'k1', updatedAt: 1 },
      { kind: 'basename', identifier: '__proto__', ekey: 'evil', updatedAt: 2 },
    ],
  });
  check("快照里记录了 'constructor' 自有键", Object.hasOwn(snapshot.byBasename, 'constructor'));
  check('快照拒绝写入 __proto__', !Object.hasOwn(snapshot.byBasename, '__proto__'));
  eq('快照的原型是 null（不会被污染）', Object.getPrototypeOf(snapshot.byBasename), null);
  eq(
    "空保险库查 'toString' 返回 undefined",
    resolveEkeyFromVault(
      { byFilename: {}, byMid: {}, byBasename: {} },
      { kind: 'qmc2-unknown' },
      'toString.mflac',
    ),
    undefined,
  );
}

/* ------------------------------------------------------------------ */
/* 汇总                                                               */
/* ------------------------------------------------------------------ */
if (failures.length > 0) {
  console.error(`\n✗ 自检失败 ${failures.length} 项（通过 ${passed} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ 内核自检全部通过（${passed} 项）`);
}
