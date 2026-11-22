/**
 * QMC 相关模块的统一出口 + 尾部 → UI 定位信息的映射。
 */
import type { KeyLookupInfo } from '../types';
import { basename, stripExtension } from '../filename';
import type { QmcFooter } from './footer';

export * from './qmc1';
export * from './qmc2';
export * from './ekey';
export * from './footer';

/**
 * 尾部可能不带任何标识（MusicEx / STag 的两个字符串字段都为空、或用户给的文件没有名字）。
 * 这时用「原文件名去扩展名」兜底，保证 need-key 一定有可显示、可存进保险库的键，
 * 下次拖同一个文件进来就能按 basename 自动命中。
 */
function fallbackName(fileName?: string): string | undefined {
  const base = basename(fileName);
  if (!base) return undefined;
  return stripExtension(base) || base;
}

/** 把解析出的尾部转换成 UI / 保险库能用的定位信息。 */
export function keyInfoFromFooter(footer: QmcFooter, fileName?: string): KeyLookupInfo {
  const fallback = fallbackName(fileName);
  switch (footer.kind) {
    case 'musicex':
      return {
        kind: 'qmc2-musicex',
        mid: footer.mid || undefined,
        mediaFilename: footer.mediaFilename || undefined,
        suggestedName: footer.mediaFilename || fallback,
      };
    case 'stag':
      return {
        kind: 'qmc2-stag',
        mid: footer.mediaMid || undefined,
        resourceId: footer.resourceId,
        suggestedName: fallback,
      };
    case 'qtag':
      return {
        kind: 'qmc2-qtag',
        resourceId: footer.resourceId,
        suggestedName: fallback,
      };
    case 'pcv1':
      return { kind: 'qmc2-pcv1', suggestedName: fallback };
  }
}
