import { describe, expect, it } from 'vitest';
import { basename, decryptFile, resolveEkeyFromVault } from '../detect';
import { decryptQMC1 } from '../qmc/qmc1';
import { createQmc2Cipher } from '../qmc/qmc2';
import { decryptEkey } from '../qmc/ekey';
import { DecryptAbortedError } from '../types';
import {
  buildMusicExTail,
  buildPcV1Tail,
  buildQTagTail,
  buildSTagTail,
  buildNcm,
  makeEkeyV1,
  makeFakeAudio,
} from './helpers/build';
import { bytesToHex, concatBytes, latin1Encode } from '../bytes';

/** 上游 ekey 向量（39 字节 key → QMC2 Map 路径）。 */
const EKEY_V1 =
  'MTIzNDU2NzhN2csrbjHfIPH0BrVByijvtaAXJdb4Iy7P/ktYG6Wxly+Vz5sZ5nqDPUHoVBuuzSQ=';

const AUDIO = makeFakeAudio(320);

/** 用上游 ekey 对应的密钥加密一段音频（QMC2 Map）。 */
function encryptQmc2(audio: Uint8Array): Uint8Array {
  const cipher = createQmc2Cipher(decryptEkey(EKEY_V1));
  const enc = audio.slice();
  cipher.decrypt(enc, 0);
  return enc;
}

describe('detect: 兜底与明文', () => {
  it('空文件 → unsupported「文件为空」', () => {
    const out = decryptFile(new Uint8Array(0));
    expect(out.status).toBe('unsupported');
    expect(out.status === 'unsupported' ? out.reason : '').toContain('文件为空');
  });

  it('随机字节 → unsupported', () => {
    const noise = new Uint8Array(512);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 97 + 11) & 0xff;
    expect(decryptFile(noise).status).toBe('unsupported');
  });

  it('明文音频透传（cipher=AUDIO，ext 由魔数推断）', () => {
    const out = decryptFile(AUDIO.slice(), { fileName: 'plain.flac' });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cipher).toBe('AUDIO');
    expect(out.ext).toBe('flac');
    expect(bytesToHex(out.data)).toBe(bytesToHex(AUDIO));
  });
});

describe('detect: QMC1', () => {
  it('识别 QMC1 并解出原始音频', () => {
    const enc = AUDIO.slice();
    decryptQMC1(enc, 0);
    const out = decryptFile(enc, { fileName: 'song.qmcflac' });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cipher).toBe('QMC1');
    expect(out.ext).toBe('flac');
    expect(bytesToHex(out.data)).toBe(bytesToHex(AUDIO));
  });

  it('通过 onProgress 汇报进度，最后一个值为 1', () => {
    const enc = AUDIO.slice();
    decryptQMC1(enc, 0);
    const ratios: number[] = [];
    decryptFile(enc, { onProgress: (r) => ratios.push(r) });
    expect(ratios.length).toBeGreaterThan(0);
    expect(ratios[ratios.length - 1]).toBe(1);
  });

  it('isAborted 返回 true 时抛 DecryptAbortedError', () => {
    const enc = AUDIO.slice();
    decryptQMC1(enc, 0);
    expect(() => decryptFile(enc, { isAborted: () => true })).toThrow(DecryptAbortedError);
  });
});

describe('detect: QMC2 + MusicEx（无内嵌 ekey）', () => {
  const file = concatBytes(encryptQmc2(AUDIO), buildMusicExTail('001y7CaR29k6YP', 'F0M000112233445566.mflac'));

  it('没有 ekey → need-key，且带出 mid / mediaFilename', () => {
    const out = decryptFile(file.slice(), { fileName: 'song.mflac' });
    expect(out.status).toBe('need-key');
    if (out.status !== 'need-key') return;
    expect(out.info.kind).toBe('qmc2-musicex');
    expect(out.info.mid).toBe('001y7CaR29k6YP');
    expect(out.info.mediaFilename).toBe('F0M000112233445566.mflac');
    expect(out.info.suggestedName).toBe('F0M000112233445566.mflac');
  });

  it('传入正确 ekey → ok 且字节完全一致', () => {
    const out = decryptFile(file.slice(), { ekey: EKEY_V1 });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cipher).toBe('QMC2/Map');
    expect(bytesToHex(out.data)).toBe(bytesToHex(AUDIO));
  });

  it('保险库 byFilename 命中 → ok', () => {
    const out = decryptFile(file.slice(), {
      vault: {
        byFilename: { 'F0M000112233445566.mflac': EKEY_V1 },
        byMid: {},
        byBasename: {},
      },
    });
    expect(out.status).toBe('ok');
  });

  it('保险库 byMid 命中 → ok', () => {
    const out = decryptFile(file.slice(), {
      vault: { byFilename: {}, byMid: { '001y7CaR29k6YP': EKEY_V1 }, byBasename: {} },
    });
    expect(out.status).toBe('ok');
  });

  it('保险库 byBasename 命中（Windows 路径也能取到 basename）→ ok', () => {
    const out = decryptFile(file.slice(), {
      fileName: 'C:\\Music\\song.mflac',
      vault: { byFilename: {}, byMid: {}, byBasename: { 'song.mflac': EKEY_V1 } },
    });
    expect(out.status).toBe('ok');
  });

  it('保险库键大小写不敏感 → ok', () => {
    const out = decryptFile(file.slice(), {
      vault: { byFilename: { 'f0m000112233445566.MFLAC': EKEY_V1 }, byMid: {}, byBasename: {} },
    });
    expect(out.status).toBe('ok');
  });

  it('错误 ekey → bad-key（绝不静默输出噪声）', () => {
    const wrong = makeEkeyV1(new Uint8Array(39).fill(0x5a));
    const out = decryptFile(file.slice(), { ekey: wrong });
    expect(out.status).toBe('bad-key');
    if (out.status !== 'bad-key') return;
    expect(out.reason).toContain('不是音频');
    expect(out.info.kind).toBe('qmc2-musicex');
  });

  it('结构合法但 ekey 解码失败 → bad-key（reason 说明 ekey 解析失败）', () => {
    const out = decryptFile(file.slice(), { ekey: '这不是一个ekey' });
    expect(out.status).toBe('bad-key');
    if (out.status !== 'bad-key') return;
    expect(out.reason).toContain('ekey 解析失败');
  });
});

describe('detect: QMC2 + STag / QTag / PCv1', () => {
  it('STag 无 ekey → need-key，info 带 mid 与 resourceId', () => {
    const file = concatBytes(encryptQmc2(AUDIO), buildSTagTail('5177785', '001y7CaR29k6YP'));
    const out = decryptFile(file, { fileName: 'x.mgg' });
    expect(out.status).toBe('need-key');
    if (out.status !== 'need-key') return;
    expect(out.info.kind).toBe('qmc2-stag');
    expect(out.info.mid).toBe('001y7CaR29k6YP');
    expect(out.info.resourceId).toBe('5177785');
  });

  it('STag + 用户 ekey → ok 且字节一致', () => {
    const file = concatBytes(encryptQmc2(AUDIO), buildSTagTail('5177785', '001y7CaR29k6YP'));
    const out = decryptFile(file, { ekey: EKEY_V1 });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(bytesToHex(out.data)).toBe(bytesToHex(AUDIO));
  });

  it('QTag 内嵌 ekey → 零输入自动解密 ok', () => {
    const file = concatBytes(encryptQmc2(AUDIO), buildQTagTail(EKEY_V1, '326454301'));
    const out = decryptFile(file, { fileName: 'y.mgg' });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cipher).toBe('QMC2/Map');
    expect(bytesToHex(out.data)).toBe(bytesToHex(AUDIO));
  });

  it('PCv1Legacy 内嵌 ekey → 自动解密 ok', () => {
    const file = concatBytes(encryptQmc2(AUDIO), buildPcV1Tail(EKEY_V1, 0x2c0));
    const out = decryptFile(file, { fileName: 'z.mgg' });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(bytesToHex(out.data)).toBe(bytesToHex(AUDIO));
  });

  it('尾部命中但内容已是明文音频 → 按 AUDIO 输出并带 warning', () => {
    const file = concatBytes(AUDIO.slice(), buildSTagTail());
    const out = decryptFile(file, { fileName: 'weird.mgg' });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cipher).toBe('AUDIO');
    expect(out.warnings.some((w) => w.includes('QMC'))).toBe(true);
  });
});

describe('detect: 无尾部但用户手输 ekey', () => {
  it('QMC2 密文 + 正确 ekey → ok', () => {
    const out = decryptFile(encryptQmc2(AUDIO), { ekey: EKEY_V1 });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(bytesToHex(out.data)).toBe(bytesToHex(AUDIO));
  });

  it('QMC2 密文 + 错误 ekey → bad-key（info.kind = qmc2-unknown）', () => {
    const wrong = makeEkeyV1(new Uint8Array(39).fill(0x01));
    const out = decryptFile(encryptQmc2(AUDIO), { ekey: wrong });
    expect(out.status).toBe('bad-key');
    if (out.status !== 'bad-key') return;
    expect(out.info.kind).toBe('qmc2-unknown');
  });

  it('QMC2/RC4 路径（长密钥）也能通过 decryptFile 解密', () => {
    const longKey = new Uint8Array(500);
    for (let i = 0; i < longKey.length; i++) longKey[i] = (i * 13 + 7) & 0xff;
    const ekey = makeEkeyV1(longKey);
    const cipher = createQmc2Cipher(decryptEkey(ekey));
    expect(cipher.kind).toBe('rc4');
    const enc = AUDIO.slice();
    cipher.decrypt(enc, 0);
    const out = decryptFile(enc, { ekey });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cipher).toBe('QMC2/RC4');
    expect(bytesToHex(out.data)).toBe(bytesToHex(AUDIO));
  });
});

describe('detect: NCM 分支', () => {
  it('合成 NCM → ok，cipher=NCM，ext 来自 metadata', () => {
    const built = buildNcm({ audio: AUDIO });
    const out = decryptFile(built.file.slice(), { fileName: 'song.ncm' });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cipher).toBe('NCM');
    expect(out.ext).toBe('flac');
    expect(bytesToHex(out.data)).toBe(bytesToHex(AUDIO));
    expect(out.meta?.title).toBe('合成样本曲目');
  });

  it('metadata.format 与实际容器冲突时以实际魔数为准', () => {
    const built = buildNcm({ audio: AUDIO, meta: { musicName: 'x', format: 'mp3' } });
    const out = decryptFile(built.file.slice());
    expect(out.status === 'ok' ? out.ext : '').toBe('flac');
  });

  it('NCM 结构损坏 → unsupported，reason 带「NCM 解析失败」', () => {
    const built = buildNcm({ audio: AUDIO });
    const broken = built.file.slice();
    broken[10] = 0; // keyLen = 0
    broken[11] = 0;
    broken[12] = 0;
    broken[13] = 0x01; // 0x01000000 → 超上限
    const out = decryptFile(broken);
    expect(out.status).toBe('unsupported');
    if (out.status !== 'unsupported') return;
    expect(out.reason).toContain('NCM 解析失败');
  });
});

describe('detect: 辅助函数', () => {
  it('basename 兼容 / 与 \\\\ 分隔符', () => {
    expect(basename('C:\\Music\\a.mflac')).toBe('a.mflac');
    expect(basename('/music/a.mflac')).toBe('a.mflac');
    expect(basename('a.mflac')).toBe('a.mflac');
    expect(basename(undefined)).toBeUndefined();
  });

  it('resolveEkeyFromVault 优先 mediaFilename，其次 mid，最后 basename', () => {
    const vault = {
      byFilename: { 'F.mflac': 'from-filename' },
      byMid: { mid1: 'from-mid' },
      byBasename: { 'song.mflac': 'from-basename' },
    };
    const info = { kind: 'qmc2-musicex' as const, mid: 'mid1', mediaFilename: 'F.mflac' };
    expect(resolveEkeyFromVault(vault, info, 'dir/song.mflac')).toBe('from-filename');
    expect(resolveEkeyFromVault(vault, { ...info, mediaFilename: undefined }, 'dir/song.mflac')).toBe(
      'from-mid',
    );
    expect(
      resolveEkeyFromVault(vault, { ...info, mediaFilename: undefined, mid: undefined }, 'dir/song.mflac'),
    ).toBe('from-basename');
    expect(resolveEkeyFromVault(undefined, info, 'song.mflac')).toBeUndefined();
  });

  it('保险库为空对象时回退到 need-key（不误判成功）', () => {
    const file = concatBytes(encryptQmc2(AUDIO), buildMusicExTail('m', 'f.mflac'));
    const out = decryptFile(file, {
      vault: { byFilename: {}, byMid: {}, byBasename: {} },
    });
    expect(out.status).toBe('need-key');
  });

  it('尾部以 STag 结尾的 40 字节明文也走明文分支', () => {
    const tiny = concatBytes(latin1Encode('fLaC'), new Uint8Array(36).fill(0x11));
    const out = decryptFile(concatBytes(tiny, buildSTagTail()));
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' ? out.cipher : '').toBe('AUDIO');
  });
});
