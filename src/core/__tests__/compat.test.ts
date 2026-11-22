import { describe, expect, it } from 'vitest';
import { hasOwn, readBlobBuffer } from '../compat';

describe('compat / 旧 Safari 兜底', () => {
  it('hasOwn 不会命中原型链', () => {
    const map: Record<string, string> = { song: 'key' };
    expect(hasOwn(map, 'song')).toBe(true);
    expect(hasOwn(map, 'constructor')).toBe(false);
    expect(hasOwn(map, 'toString')).toBe(false);
    expect(hasOwn(map, '__proto__')).toBe(false);
  });

  it('Blob 没有 arrayBuffer 时退回 FileReader', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 250])]);
    // 模拟 Safari 13 及更早：实例上没有 arrayBuffer
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined, configurable: true });
    const buffer = await readBlobBuffer(blob);
    expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3, 250]);
  });

  it('原生 arrayBuffer 可用时直接走原生路径', async () => {
    const blob = new Blob([new Uint8Array([9, 8, 7])]);
    const buffer = await readBlobBuffer(blob);
    expect(Array.from(new Uint8Array(buffer))).toEqual([9, 8, 7]);
  });
});
