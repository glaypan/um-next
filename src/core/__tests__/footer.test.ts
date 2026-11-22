import { describe, expect, it } from 'vitest';
import {
  MUSICEX_TOTAL_SIZE,
  PCV1_MAX_EKEY_LEN,
  parseQmcFooter,
} from '../qmc/footer';
import { buildMusicExTail, buildPcV1Tail, buildQTagTail, buildSTagTail } from './helpers/build';
import { concatBytes, latin1Encode, writeU32BE, writeU32LE } from '../bytes';
import type { QmcFooter } from '../qmc/footer';

const EKEY_V1 =
  'MTIzNDU2NzhN2csrbjHfIPH0BrVByijvtaAXJdb4Iy7P/ktYG6Wxly+Vz5sZ5nqDPUHoVBuuzSQ=';

/** 把 footer 前面垫一段「音频」再解析——真实调用总是拿到文件末 4096 字节。 */
function withPrefix(prefix: Uint8Array, footer: Uint8Array): Uint8Array {
  return concatBytes(prefix, footer);
}

describe('footer: STag（Android，无 ekey）', () => {
  const tail = withPrefix(latin1Encode('fLaC-audio-prefix'), buildSTagTail('5177785', '001y7CaR29k6YP'));

  it('能被识别为 stag', () => {
    expect(parseQmcFooter(tail)?.kind).toBe('stag');
  });

  it('size = payloadLen + 8', () => {
    const parsed = parseQmcFooter(tail) as Extract<QmcFooter, { kind: 'stag' }>;
    const csvLen = '5177785,2,001y7CaR29k6YP'.length;
    expect(parsed.size).toBe(csvLen + 8);
  });

  it('带出 resourceId 与 mediaMid', () => {
    const parsed = parseQmcFooter(tail) as Extract<QmcFooter, { kind: 'stag' }>;
    expect(parsed.resourceId).toBe('5177785');
    expect(parsed.mediaMid).toBe('001y7CaR29k6YP');
  });

  it('CSV 版本字段不是 2 → 返回 null', () => {
    const csv = latin1Encode('5177785,3,001y7CaR29k6YP');
    const len = new Uint8Array(4);
    writeU32BE(len, 0, csv.length);
    expect(parseQmcFooter(concatBytes(csv, len, latin1Encode('STag')))).toBeNull();
  });

  it('resourceId 非数字 → 返回 null', () => {
    const csv = latin1Encode('abc,2,001y7CaR29k6YP');
    const len = new Uint8Array(4);
    writeU32BE(len, 0, csv.length);
    expect(parseQmcFooter(concatBytes(csv, len, latin1Encode('STag')))).toBeNull();
  });

  it('CSV 字段数不是 3 → 返回 null', () => {
    const csv = latin1Encode('5177785,2');
    const len = new Uint8Array(4);
    writeU32BE(len, 0, csv.length);
    expect(parseQmcFooter(concatBytes(csv, len, latin1Encode('STag')))).toBeNull();
  });

  it('payloadLen 超出可用长度 → 返回 null（不抛异常）', () => {
    const csv = latin1Encode('5177785,2,001y7CaR29k6YP');
    const len = new Uint8Array(4);
    writeU32BE(len, 0, csv.length + 100);
    expect(parseQmcFooter(concatBytes(csv, len, latin1Encode('STag')))).toBeNull();
  });
});

describe('footer: QTag（Android，内嵌 ekey）', () => {
  const tail = buildQTagTail(EKEY_V1, '326454301');

  it('能被识别为 qtag 并带出 ekey / resourceId', () => {
    const parsed = parseQmcFooter(tail) as Extract<QmcFooter, { kind: 'qtag' }>;
    expect(parsed.kind).toBe('qtag');
    expect(parsed.ekey).toBe(EKEY_V1);
    expect(parsed.resourceId).toBe('326454301');
    expect(parsed.size).toBe(`${EKEY_V1},326454301,2`.length + 8);
  });

  it('ekey 含非 base64 字符 → 返回 null', () => {
    const csv = latin1Encode('这不是base64,326454301,2');
    const len = new Uint8Array(4);
    writeU32BE(len, 0, csv.length);
    // 注意：中文 latin1 编码后是单字节，但仍不在 base64 字母表内
    expect(parseQmcFooter(concatBytes(csv, len, latin1Encode('QTag')))).toBeNull();
  });

  it('版本字段不是 2 → 返回 null', () => {
    const csv = latin1Encode(`${EKEY_V1},326454301,1`);
    const len = new Uint8Array(4);
    writeU32BE(len, 0, csv.length);
    expect(parseQmcFooter(concatBytes(csv, len, latin1Encode('QTag')))).toBeNull();
  });
});

describe('footer: MusicEx（PC ≥ 19.57）', () => {
  const tail = buildMusicExTail('AaBbCcDdEeFfGg', 'F0M000112233445566.mflac');

  it('总长固定 0xC0', () => {
    expect(tail.length).toBe(MUSICEX_TOTAL_SIZE);
  });

  it('能被识别并带出 mid / mediaFilename', () => {
    const parsed = parseQmcFooter(tail) as Extract<QmcFooter, { kind: 'musicex' }>;
    expect(parsed.kind).toBe('musicex');
    expect(parsed.mid).toBe('AaBbCcDdEeFfGg');
    expect(parsed.mediaFilename).toBe('F0M000112233445566.mflac');
    expect(parsed.size).toBe(MUSICEX_TOTAL_SIZE);
  });

  it('前面有音频数据时仍能正确定位（只看末尾 0xC0）', () => {
    const parsed = parseQmcFooter(withPrefix(new Uint8Array(3000).fill(0x33), tail));
    expect(parsed?.kind).toBe('musicex');
  });

  it('version ≠ 1 → 返回 null', () => {
    expect(parseQmcFooter(buildMusicExTail('mid-1', 'f.mflac', 2))).toBeNull();
    expect(parseQmcFooter(buildMusicExTail('mid-1', 'f.mflac', 0))).toBeNull();
  });

  it('payloadLen ≠ 0xC0 → 返回 null', () => {
    expect(parseQmcFooter(buildMusicExTail('mid-1', 'f.mflac', 1, 0xc1))).toBeNull();
    expect(parseQmcFooter(buildMusicExTail('mid-1', 'f.mflac', 1, 0))).toBeNull();
  });

  it('mid/mediaFilename 遇到 NUL 停止（UTF-16LE 定长字段被截断）', () => {
    const t = buildMusicExTail('AB', 'C.mflac');
    const parsed = parseQmcFooter(t) as Extract<QmcFooter, { kind: 'musicex' }>;
    expect(parsed.mid).toBe('AB');
    expect(parsed.mediaFilename).toBe('C.mflac');
  });

  it('mid 为空时不影响解析（返回空字符串，由上层决定是否可用）', () => {
    const parsed = parseQmcFooter(buildMusicExTail('', 'only-name.flac'));
    expect(parsed?.kind).toBe('musicex');
    expect((parsed as Extract<QmcFooter, { kind: 'musicex' }>).mediaFilename).toBe('only-name.flac');
  });

  it('尾部不足 0xC0 字节 → 返回 null', () => {
    expect(parseQmcFooter(withPrefix(new Uint8Array(10), new Uint8Array(0xc0 - 1)))).toBeNull();
  });
});

describe('footer: PCv1Legacy', () => {
  it('能被识别并带出 ekey（NUL 补齐部分被裁掉）', () => {
    const parsed = parseQmcFooter(buildPcV1Tail(EKEY_V1, 0x2c0)) as Extract<
      QmcFooter,
      { kind: 'pcv1' }
    >;
    expect(parsed.kind).toBe('pcv1');
    expect(parsed.ekey).toBe(EKEY_V1);
    expect(parsed.size).toBe(0x2c4);
  });

  it('payloadLen 超上限（> 0x500）视为「不是本类型」→ null', () => {
    const payload = new Uint8Array(PCV1_MAX_EKEY_LEN + 0x10);
    payload.set(latin1Encode(EKEY_V1), 0);
    const len = new Uint8Array(4);
    writeU32LE(len, 0, payload.length);
    expect(parseQmcFooter(concatBytes(payload, len))).toBeNull();
  });

  it('payloadLen < 16 视为「不是本类型」→ null', () => {
    const payload = new Uint8Array(8);
    payload.set(latin1Encode('AAAAAA'), 0);
    const len = new Uint8Array(4);
    writeU32LE(len, 0, payload.length);
    expect(parseQmcFooter(concatBytes(payload, len))).toBeNull();
  });

  it('ekey 段不是 base64 → null', () => {
    const payload = new Uint8Array(64);
    payload.set(latin1Encode('@@@@@@@@@@@@@@@@@@@@'), 0);
    const len = new Uint8Array(4);
    writeU32LE(len, 0, payload.length);
    expect(parseQmcFooter(concatBytes(payload, len))).toBeNull();
  });
});

describe('footer: 误判防御', () => {
  it('全 0x41 的数据不命中任何尾部类型', () => {
    expect(parseQmcFooter(new Uint8Array(64).fill(0x41))).toBeNull();
  });

  it('不足 8 字节直接返回 null', () => {
    expect(parseQmcFooter(new Uint8Array(0))).toBeNull();
    expect(parseQmcFooter(latin1Encode('STag'))).toBeNull();
  });

  it('明文音频（fLaC…）不会被误判成尾部（识别链最后一步）', () => {
    const audio = new Uint8Array(512);
    audio.set(latin1Encode('fLaC'), 0);
    for (let i = 4; i < audio.length; i++) audio[i] = (i * 31 + 7) & 0xff;
    expect(parseQmcFooter(audio)).toBeNull();
  });

  it('识别顺序固定：STag 优先于 QTag', () => {
    // 同时以 "STag" 结尾的 QTag 结构不成立，但构造一个 STag 尾部验证优先返回 stag
    const parsed = parseQmcFooter(buildSTagTail());
    expect(parsed?.kind).toBe('stag');
  });
});
