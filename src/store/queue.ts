/** 队列数据模型与展示辅助（与 React 无关，便于复用与推理）。 */
import type { CipherName, CoverImage, KeyLookupInfo, KeySource, TrackMeta } from '../core/types';

export type ItemStatus = 'pending' | 'running' | 'converting' | 'need-key' | 'done' | 'failed' | 'cancelled';

export interface QueueItem {
  id: string;
  file: File;
  name: string;
  size: number;
  status: ItemStatus;
  /** 0..1 */
  progress: number;
  cipher?: CipherName;
  ext?: string;
  meta?: TrackMeta;
  cover?: CoverImage;
  data?: Uint8Array;
  keyInfo?: KeyLookupInfo;
  /** 失败/提示信息（中文）。 */
  message?: string;
  warnings: string[];
  /** 这次解密实际用的密钥来源（文件内嵌 / 保险库 / 手输 / 无需密钥）。 */
  keySource?: KeySource;
}

export function createQueueItem(file: File): QueueItem {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    name: file.name,
    size: file.size,
    status: 'pending',
    progress: 0,
    warnings: [],
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function statusLabel(item: QueueItem): string {
  switch (item.status) {
    case 'pending':
      return '等待';
    case 'running':
      return item.progress > 0 && item.progress < 1
        ? `解密中 ${Math.round(item.progress * 100)}%`
        : '解析中';
    case 'converting':
      return item.progress > 0 && item.progress < 1
        ? `转 MP3 ${Math.round(item.progress * 100)}%`
        : '转 MP3…';
    case 'need-key':
      return '需要密钥';
    case 'done':
      return '完成';
    case 'failed':
      return item.message ? `失败（${item.message}）` : '失败';
    case 'cancelled':
      return '已取消';
  }
}

/** 去掉文件名非法字符。 */
function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
}

/** 原始文件名去掉扩展名。 */
export function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

/** 下载用文件名：`歌手 - 标题.ext`，缺失字段回退原文件名。 */
export function buildFileName(item: QueueItem): string {
  const ext = item.ext ?? 'bin';
  const title = item.meta?.title?.trim();
  if (!title) return `${sanitizeName(stripExtension(item.name))}.${ext}`;
  const artist = item.meta?.artist?.trim();
  const base = artist ? `${sanitizeName(artist)} - ${sanitizeName(title)}` : sanitizeName(title);
  return `${base || sanitizeName(stripExtension(item.name))}.${ext}`;
}

/** 封面文件名。 */
export function buildCoverFileName(item: QueueItem): string {
  const ext = item.cover?.mime.includes('png')
    ? 'png'
    : item.cover?.mime.includes('webp')
      ? 'webp'
      : item.cover?.mime.includes('gif')
        ? 'gif'
        : 'jpg';
  return `${sanitizeName(stripExtension(item.name))}-封面.${ext}`;
}
