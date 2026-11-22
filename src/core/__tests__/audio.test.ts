import { describe, expect, it } from 'vitest';
import { guessAudioFormat, looksLikeAudio, mimeForExt } from '../audio';
import { concatBytes, latin1Encode } from '../bytes';

describe('audio: 容器魔数识别', () => {
  it('识别 FLAC（fLaC）', () => {
    expect(guessAudioFormat(latin1Encode('fLaC\u0000\u0000\u0000\u0000'))).toEqual({
      ext: 'flac',
      mime: 'audio/flac',
    });
  });

  it('识别 Ogg / WAV / APE / WV / DSF', () => {
    expect(guessAudioFormat(latin1Encode('OggS....'))?.ext).toBe('ogg');
    expect(guessAudioFormat(latin1Encode('RIFFxxxx'))?.ext).toBe('wav');
    expect(guessAudioFormat(latin1Encode('MAC xxxx'))?.ext).toBe('ape');
    expect(guessAudioFormat(latin1Encode('wvpkxxxx'))?.ext).toBe('wv');
    expect(guessAudioFormat(latin1Encode('DSD xxxx'))?.ext).toBe('dsf');
  });

  it('识别 m4a：ftyp 落在 offset 4', () => {
    expect(guessAudioFormat(latin1Encode('....ftypM4A '))?.ext).toBe('m4a');
  });

  it('识别 mp3：ID3 标签与裸帧同步 0xFF 0xEx', () => {
    expect(guessAudioFormat(latin1Encode('ID3\u0004\u0000\u0000'))?.ext).toBe('mp3');
    expect(guessAudioFormat(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))?.ext).toBe('mp3');
  });

  it('不足 4 字节一律判为非音频', () => {
    expect(guessAudioFormat(latin1Encode('fLa'))).toBeNull();
    expect(guessAudioFormat(new Uint8Array(0))).toBeNull();
  });

  it('随机噪声不命中任何音频魔数', () => {
    const noise = new Uint8Array(64);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 97 + 11) & 0xff;
    // 首字节 0x0b 不是 0xFF，也不匹配任何 ASCII 魔数
    expect(looksLikeAudio(noise)).toBe(false);
  });

  it('looksLikeAudio 是 guessAudioFormat 的布尔包装', () => {
    expect(looksLikeAudio(concatBytes(latin1Encode('fLaC'), new Uint8Array(4)))).toBe(true);
  });
});

describe('audio: 扩展名 → MIME', () => {
  it('已知扩展名映射到 audio/*', () => {
    expect(mimeForExt('flac')).toBe('audio/flac');
    expect(mimeForExt('MP3')).toBe('audio/mpeg');
    expect(mimeForExt('OGG')).toBe('audio/ogg');
  });

  it('未知扩展名退回 application/octet-stream', () => {
    expect(mimeForExt('bin')).toBe('application/octet-stream');
    expect(mimeForExt('')).toBe('application/octet-stream');
  });
});
