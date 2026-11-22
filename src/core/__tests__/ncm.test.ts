import { describe, expect, it } from 'vitest';
import {
  NcmParseError,
  buildNcmKeyStream,
  decryptContentKey,
  decryptMetadata,
  decryptNcmAudio,
  isNcm,
  parseNcm,
} from '../ncm/index';
import { aes128EcbEncryptPkcs7 } from '../aes128';
import { bytesToHex, concatBytes, hexToBytes, latin1Decode, latin1Encode, writeU32LE } from '../bytes';
import { DecryptAbortedError } from '../types';
import { buildNcm, makeFakeAudio, TEST_CONTENT_KEY } from './helpers/build';

/** 上游 NCM content key 密文（161 字节）。 */
const ENC_KEY_HEX =
  '2cced5eb69eafb14550d45bf61dd171d9371471ee1dddaf4d5e84f1cba0020c302e9fe2992e181456f18c72d11f2bc5bbcdc2233f968b4b028383f636c886635f9e7b1700eee55acb8ed8b4817253ae65eb580788acddce1ef3d30ec9c2ac6c751ae3d11b564889ed67766f62b529efaf963f6de27104582ac2d2084954c0f7aae8b916d102e631ceacaf91497d8b3e8';
const EXPECTED_CONTENT_KEY =
  '174279197715752960061821572626E7fT49x7dof9OKCgg9cdvhEuezy3iZCL1nFvBFd1T4uSktAJKmwZXsijPbijliionVUXXg9plTbXEclAE9Lb';

/** 上游 NCM metadata 密文。 */
const META_HEX =
  '5255504308061a4b270c0d4417430e0c070a051a4a592f555725365034573a1b3b503925370e0139485b4c0509072b5522004831324c17070d241a3911265a15292450020720562d335a0c10292622284c1a0d0b06280d2c1b092e0b2b2802130f2f2c0e251b4c2b52333609372d0b25272c0c0d0251355a1a352d2f3b542a0d4c2b161b0c26210b522552365b515056010a19145b573207065025555453302c32521500503739280e150f36481124335607222029142806160154480b172025360201160727160c37202a24212250560e3452371429103220362d522102093b0b01170033360d01212b174c39023351022007374c5a253909512550544c193237080632551b530b0b4c081633542711021a30285725503b2e2834513b361153125609212b2c142d245a0253162129160253022a312d31563b1751520f5650560017572f081a5225122d480502370f363005145a375a50551609533b1b241a1a215006372e5709391713263104525055105352570204022f015a022a2f194c0c5500502d29061611200d015322321b34000a0602150f255a1a22110e2132312239565a0916351630290f30272c55521248160f0c360c252728350a1a060916391b081027122c2c5b48014833480e1b541b0236252048310b060d151117012420273130220f2208170f130c0c1a1212514c3b533b37391625055410320d480c505b200b1922190d0b282c0b053b5109540a060f570851502429165733361504505b2f515612092f2730512b375724355b0c0e0d0d532a2506332229512408513a060e1631362b103430080a2f19325a043952361a26140e0b2a4c39561a012f14333356162529330e0b2d1a11290815022b4c010c070f154c3636094c1353111112020f11562b5b21290b5109023b1102241612040a370b225a0b020a0236362a291a1414131b2c11312a4c28112b1b30513511530d090f390f2517025b1a39265b513b2e042e2136043b11560a2e2d1a27211007531137072f51572b2457015335520f2f2d4852562b00171a39001209020702522c204c394c48500d0f154c002b0f37481917323531280b0d2d3210325633283b2b5512040750240008011026302c3410210d25022e53112b1936312e5a523335201453300405083413025422055a01201314392a251b374857532a223a0034532412';

describe('ncm: 上游 content key 向量', () => {
  it('解出 114 字节 content key', () => {
    const key = decryptContentKey(hexToBytes(ENC_KEY_HEX));
    expect(key.length).toBe(114);
    expect(latin1Decode(key)).toBe(EXPECTED_CONTENT_KEY);
  });

  it('空密文抛 NcmParseError', () => {
    expect(() => decryptContentKey(new Uint8Array(0))).toThrow(NcmParseError);
  });

  it('前缀不匹配时抛「解密失败」', () => {
    // 用错误密钥加密一段带别的
    // 前缀的明文，模拟损坏的 content key
    const wrong = aes128EcbEncryptPkcs7(latin1Encode('not-the-right-prefix!!'), 'hzHRAmso5kInbaxW');
    const xored = wrong.map((b) => b ^ 0x64);
    expect(() => decryptContentKey(xored)).toThrow(/前缀不匹配/);
  });
});

describe('ncm: keystream', () => {
  it('上游向量：keystream 头尾 16 字节固定', () => {
    const ks = buildNcmKeyStream(latin1Encode(EXPECTED_CONTENT_KEY));
    expect(bytesToHex(ks.subarray(0, 16))).toBe('6720f05cacaf1b740d2640be8561450d');
    expect(bytesToHex(ks.subarray(240, 256))).toBe('cdba97dea33b67d40bf4d39725baca08');
  });

  it('keystream 长度固定 256 字节', () => {
    expect(buildNcmKeyStream(TEST_CONTENT_KEY).length).toBe(256);
  });

  it('空 content key 抛错', () => {
    expect(() => buildNcmKeyStream(new Uint8Array(0))).toThrow(/为空/);
  });

  it('decryptNcmAudio 是 XOR，按 offset%256 取流且自反', () => {
    const ks = buildNcmKeyStream(TEST_CONTENT_KEY);
    const data = new Uint8Array(300);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const before = bytesToHex(data);
    decryptNcmAudio(data, 5, ks);
    expect(data[0]).toBe((0 ^ ks[5]) & 0xff);
    decryptNcmAudio(data, 5, ks);
    expect(bytesToHex(data)).toBe(before);
  });
});

describe('ncm: 上游 metadata 向量', () => {
  it('解出 musicId / format / 日文标题', () => {
    const meta = decryptMetadata(hexToBytes(META_HEX));
    expect(meta.musicId).toBe(491320);
    expect(meta.format).toBe('mp3');
    expect(String(meta.musicName).includes('名探侦コナン')).toBe(true);
  });

  it('前缀不匹配抛错', () => {
    const bogus = latin1Encode('not-a-163-key').map((b) => b ^ 0x63);
    expect(() => decryptMetadata(bogus)).toThrow(/前缀不匹配/);
  });

  it('music: 前缀缺失抛错', () => {
    // 密文可控：直接构造 base64(AES(明文 without music:)）再 XOR 0x63
    const encRaw = aes128EcbEncryptPkcs7(latin1Encode('{"a":1}'), "#14ljk_!\\]&0U<'(");
    const text = "163 key(Don't modify):" + btoa(String.fromCharCode(...encRaw));
    const buf = latin1Encode(text).map((b) => b ^ 0x63);
    expect(() => decryptMetadata(buf)).toThrow(/music: 前缀缺失/);
  });
});

describe('ncm: isNcm', () => {
  it('识别 CTENFDAM 头', () => {
    expect(isNcm(latin1Encode('CTENFDAMxx'))).toBe(true);
  });

  it('只有 8 字节 magic 时判定为非 NCM（要求 ≥10 字节）', () => {
    expect(isNcm(latin1Encode('CTENFDAM'))).toBe(false);
  });

  it('其它内容判定为非 NCM', () => {
    expect(isNcm(latin1Encode('fLaC1234567890'))).toBe(false);
  });
});

describe('ncm: 合成整文件解析', () => {
  it('解出的音频与原文逐字节一致，且 data 是入参的视图（audioOffset 正确）', () => {
    const built = buildNcm();
    const buf = built.file.slice();
    const parsed = parseNcm(buf);
    expect(bytesToHex(parsed.data)).toBe(bytesToHex(built.audio));
    expect(parsed.data.byteOffset, 'audioOffset 计算错误会导致解出错位的数据').toBe(
      built.audioOffset,
    );
  });

  it('带封面时返回 cover 且猜出 image/jpeg', () => {
    const cover = concatBytes(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]),
      new Uint8Array(60).fill(0x11),
      Uint8Array.from([0xff, 0xd9]),
    );
    const built = buildNcm({ cover });
    const parsed = parseNcm(built.file.slice());
    expect(parsed.cover?.mime).toBe('image/jpeg');
    expect(parsed.cover?.data.length).toBe(cover.length);
    expect(bytesToHex(parsed.cover?.data ?? new Uint8Array())).toBe(bytesToHex(cover));
  });

  it('PNG 封面被识别为 image/png', () => {
    const png = concatBytes(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      new Uint8Array(32).fill(0x22),
    );
    expect(parseNcm(buildNcm({ cover: png }).file.slice()).cover?.mime).toBe('image/png');
  });

  it('无封面（frameLen=0）→ cover 为 undefined，且不产生 warning', () => {
    const parsed = parseNcm(buildNcm().file.slice());
    expect(parsed.cover).toBeUndefined();
    expect(parsed.warnings).toEqual([]);
  });

  it('metadata 正确映射到 TrackMeta（含多歌手拼接）', () => {
    const built = buildNcm({
      meta: {
        musicName: '标题',
        album: '专辑',
        format: 'flac',
        bitrate: 1411200,
        duration: 999,
        artist: [['甲', 1], ['乙', 2]],
      },
    });
    const parsed = parseNcm(built.file.slice());
    expect(parsed.meta?.title).toBe('标题');
    expect(parsed.meta?.album).toBe('专辑');
    expect(parsed.meta?.format).toBe('flac');
    expect(parsed.meta?.bitrate).toBe(1411200);
    expect(parsed.meta?.duration).toBe(999);
    expect(parsed.meta?.artist).toBe('甲 / 乙');
  });
});

describe('ncm: 3.x 容错（只告警不失败）', () => {
  it('CRC 不匹配仍然解出完整音频，并给出 warning', () => {
    const built = buildNcm({ corruptCrc: true });
    const parsed = parseNcm(built.file.slice());
    expect(bytesToHex(parsed.data)).toBe(bytesToHex(built.audio));
    expect(parsed.warnings.some((w) => w.includes('CRC'))).toBe(true);
  });

  it('coverVersion ≠ 1 时告警并按 version 1 继续', () => {
    const parsed = parseNcm(buildNcm({ coverVersion: 2 }).file.slice());
    expect(parsed.warnings.some((w) => w.includes('封面版本'))).toBe(true);
    expect(parsed.data.length > 0).toBe(true);
  });

  it('metaLen = 0（无 metadata）时不告警、meta 为 undefined', () => {
    const parsed = parseNcm(buildNcm({ meta: null }).file.slice());
    expect(parsed.meta).toBeUndefined();
    expect(parsed.warnings).toEqual([]);
    expect(parsed.data.length > 0).toBe(true);
  });

  it('metadata 密文被破坏时降级为 warning，音频仍可解出', () => {
    const built = buildNcm();
    const broken = built.file.slice();
    broken[built.metaOffset] ^= 0xff; // 破坏 "163 key(Don't modify):" 前缀
    const parsed = parseNcm(broken);
    expect(parsed.meta).toBeUndefined();
    expect(parsed.warnings.some((w) => w.includes('元数据解析失败'))).toBe(true);
    expect(bytesToHex(parsed.data)).toBe(bytesToHex(built.audio));
  });

  it('image1Len > frameLen 时截断封面并告警', () => {
    // 真实文件里 frameLen 才是权威（封面帧实际 16 字节），image1Len 字段被写成 32
    const built = buildNcm({ cover: new Uint8Array(16).fill(0x77), frameLen: 16, image1Len: 32 });
    const parsed = parseNcm(built.file.slice());
    expect(parsed.warnings.some((w) => w.includes('封面长度字段异常'))).toBe(true);
    expect(parsed.cover?.data.length).toBe(16);
    expect(bytesToHex(parsed.data), '音频仍然完整').toBe(bytesToHex(built.audio));
  });

  it('ncmVersion / clientVersion 不参与校验（3.x 出现过不同取值）', () => {
    const built = buildNcm();
    const buf = built.file.slice();
    buf[8] = 2;
    buf[9] = 5;
    expect(bytesToHex(parseNcm(buf).data)).toBe(bytesToHex(built.audio));
  });
});

describe('ncm: 结构性错误', () => {
  it('缺少 CTENFDAM 头抛 NcmParseError', () => {
    expect(() => parseNcm(new Uint8Array(64).fill(0x41))).toThrow(/CTENFDAM/);
  });

  it('content key 长度非法抛错', () => {
    const built = buildNcm();
    const buf = built.file.slice();
    const zeroLen = new Uint8Array(4);
    writeU32LE(zeroLen, 0, 0);
    buf.set(zeroLen, 10); // keyLen 字段位于 8+2
    expect(() => parseNcm(buf)).toThrow(/content key 长度非法/);
  });

  it('metadata 长度越界抛错', () => {
    const built = buildNcm();
    const buf = built.file.slice();
    const keyLen = buf[10] | (buf[11] << 8) | (buf[12] << 16) | (buf[13] << 24);
    const metaLenPos = 14 + keyLen;
    const huge = new Uint8Array(4);
    writeU32LE(huge, 0, buf.length);
    buf.set(huge, metaLenPos);
    expect(() => parseNcm(buf)).toThrow(/metadata 长度非法/);
  });

  it('封面数据越界抛错', () => {
    const built = buildNcm({ cover: new Uint8Array(8).fill(1), frameLen: 0xffff });
    expect(() => parseNcm(built.file.slice())).toThrow(/封面数据越界/);
  });

  it('解密后不是可识别音频时抛错（content key 不对）', () => {
    const built = buildNcm({ audio: new Uint8Array(200).fill(0x7f) });
    expect(() => parseNcm(built.file.slice())).toThrow(/不是可识别的音频/);
  });
});

describe('ncm: 进度与取消', () => {
  it('onProgress 单调递增且最终为 1', () => {
    const ratios: number[] = [];
    parseNcm(buildNcm({ audio: makeFakeAudio(1000) }).file.slice(), {
      onProgress: (r) => ratios.push(r),
    });
    expect(ratios.length).toBeGreaterThan(0);
    expect(ratios[ratios.length - 1]).toBe(1);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i] >= ratios[i - 1], '进度必须单调不减').toBe(true);
    }
  });

  it('音频超过 4 MiB 分块阈值时多次回调', () => {
    const ratios: number[] = [];
    const size = 4 * 1024 * 1024 + 100;
    parseNcm(buildNcm({ audio: makeFakeAudio(size) }).file.slice(), {
      onProgress: (r) => ratios.push(r),
    });
    expect(ratios.length, '4 MiB 分块，应至少回调两次').toBeGreaterThanOrEqual(2);
    expect(ratios[ratios.length - 1]).toBe(1);
  });

  it('isAborted 返回 true 时抛 DecryptAbortedError', () => {
    expect(() => parseNcm(buildNcm().file.slice(), { isAborted: () => true })).toThrow(
      DecryptAbortedError,
    );
  });
});
