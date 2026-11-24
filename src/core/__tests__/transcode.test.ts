import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { oggToMp3, pickMp3Bitrate } from '../transcode';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/fixtures', name)));
}

describe('OGG → MP3', () => {
  it('码率选择覆盖常见采样率', () => {
    expect(pickMp3Bitrate(44100, 2)).toBe(320);
    expect(pickMp3Bitrate(48000, 1)).toBe(192);
    expect(pickMp3Bitrate(32000, 2)).toBe(160);
    expect(pickMp3Bitrate(22050, 2)).toBe(128);
    expect(pickMp3Bitrate(16000, 1)).toBe(64);
  });

  it('把 3 秒 Ogg Vorbis 转成可识别的 MP3', async () => {
    const source = fixture('sample-tone.ogg');
    const result = await oggToMp3(source);

    expect(result.channels).toBe(2);
    expect(result.sampleRate).toBe(44100);
    expect(result.bitrate).toBe(320);
    expect(result.seconds).toBeCloseTo(3, 1);
    expect(result.data.length).toBeGreaterThan(50_000);
    // MP3 frame sync：11 位全 1
    expect(result.data[0]).toBe(0xff);
    expect(result.data[1] & 0xe0).toBe(0xe0);
  }, 30_000);

  it('非 Ogg 输入会给出明确错误', async () => {
    await expect(oggToMp3(fixture('sample-plain.flac'))).rejects.toThrow(/Ogg Vorbis/);
  });

  it('进度回调单调到 1', async () => {
    const ratios: number[] = [];
    await oggToMp3(fixture('sample-tone.ogg'), { onProgress: (ratio) => ratios.push(ratio) });
    expect(ratios.length).toBeGreaterThan(1);
    expect(ratios[0]).toBe(0);
    expect(ratios[ratios.length - 1]).toBe(1);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1]);
  }, 30_000);
});
