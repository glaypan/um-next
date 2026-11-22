/**
 * 扫描 Worker：读取用户选中的目录文件 → 提取 ekey 候选 → 用算法自证 → 与待解文件配对。
 *
 * 放在 Worker 里是必须的：一个 QQ 音乐数据目录可能有上千个文件，
 * 主线程读文件 + 正则 + TEA 验签会直接把界面卡死。
 */
import { readBlobBuffer } from '../core/compat';
import { buildScannedKey, extractEkeyCandidates, keyMatchesHeader, type ScannedKey } from '../core/ekeyScan';

export interface ScanFileEntry {
  path: string;
  file: File;
}

export interface ScanTarget {
  id: string;
  /** 文件前 4 KiB，用于「解出音频魔数」配对。 */
  head: ArrayBuffer;
}

export interface ScanRequest {
  type: 'scan';
  files: ScanFileEntry[];
  targets: ScanTarget[];
  limits?: {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxFiles?: number;
    maxCandidates?: number;
    maxKeys?: number;
  };
}

export type ScanPhase = 'read' | 'validate' | 'match';

export interface ScanProgress {
  phase: ScanPhase;
  done: number;
  total: number;
  files: number;
  candidates: number;
  keys: number;
  matched: number;
}

export interface ScanResult {
  matched: Array<{ id: string; ekey: string }>;
  stats: {
    filesScanned: number;
    filesSkipped: number;
    bytesRead: number;
    candidates: number;
    keys: number;
    elapsedMs: number;
  };
}

const DEFAULT_LIMITS = {
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFiles: 3000,
  maxCandidates: 20000,
  maxKeys: 400,
};

/** 明显不可能存 ekey 的二进制/媒体文件，直接跳过。 */
const SKIP_EXT =
  /\.(mp3|flac|ogg|m4a|wav|ape|wv|dsf|mflac|mgg|qmc[0-9a-z]*|ncm|kgm|kgg|kwm|vpr|mp4|mkv|avi|mov|wmv|flv|webm|jpg|jpeg|png|gif|webp|bmp|ico|tif|tiff|heic|ttf|otf|woff2?|eot|zip|rar|7z|gz|bz2|xz|iso|msi|exe|dll|sys|so|dylib|node)$/i;

const PROGRESS_INTERVAL_MS = 100;

const ctx = self as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ScanRequest>) => void): void;
};

function skipPath(path: string): boolean {
  return /(^|[\\/])(node_modules|\.git|\$Recycle\.Bin|System Volume Information)([\\/]|$)/i.test(path);
}

ctx.addEventListener('message', (event: MessageEvent<ScanRequest>) => {
  const message = event.data;
  if (!message || message.type !== 'scan') return;

  const limits = { ...DEFAULT_LIMITS, ...message.limits };
  void run(message, limits);
});

async function run(request: ScanRequest, limits: typeof DEFAULT_LIMITS): Promise<void> {
  const started = Date.now();
  const candidates = new Set<string>();
  let filesScanned = 0;
  let filesSkipped = 0;
  let bytesRead = 0;
  let lastPost = 0;

  const postProgress = (phase: ScanPhase, done: number, total: number, keys: number, matched: number) => {
    const now = Date.now();
    if (now - lastPost < PROGRESS_INTERVAL_MS && done < total) return;
    lastPost = now;
    const progress: ScanProgress = {
      phase,
      done,
      total,
      files: filesScanned,
      candidates: candidates.size,
      keys,
      matched,
    };
    ctx.postMessage({ type: 'progress', ...progress });
  };

  const files = request.files.slice(0, limits.maxFiles);
  filesSkipped += Math.max(0, request.files.length - files.length);

  // 阶段 1：逐文件读取并提取候选
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    const file = entry.file;
    if (
      skipPath(entry.path) ||
      SKIP_EXT.test(file.name) ||
      file.size === 0 ||
      file.size > limits.maxFileBytes ||
      bytesRead + file.size > limits.maxTotalBytes
    ) {
      filesSkipped += 1;
      postProgress('read', i + 1, files.length, 0, 0);
      continue;
    }

    try {
      const buffer = new Uint8Array(await readBlobBuffer(file));
      bytesRead += buffer.byteLength;
      filesScanned += 1;
      for (const candidate of extractEkeyCandidates(buffer)) {
        candidates.add(candidate);
        if (candidates.size >= limits.maxCandidates) break;
      }
    } catch {
      filesSkipped += 1;
    }

    postProgress('read', i + 1, files.length, 0, 0);
    if (candidates.size >= limits.maxCandidates) break;
  }

  // 阶段 2：候选自证（tc_tea + 长度约束），构造可复用的 cipher
  const keys: ScannedKey[] = [];
  const list = [...candidates];
  for (let i = 0; i < list.length && keys.length < limits.maxKeys; i++) {
    const scanned = buildScannedKey(list[i]);
    if (scanned) keys.push(scanned);
    if (i % 50 === 0) postProgress('validate', i + 1, list.length, keys.length, 0);
  }
  postProgress('validate', list.length, list.length, keys.length, 0);

  // 阶段 3：与待解文件配对（解出音频魔数才算命中）
  const matched: Array<{ id: string; ekey: string }> = [];
  const targets = request.targets;
  for (let t = 0; t < targets.length; t++) {
    const target = targets[t];
    const head = new Uint8Array(target.head);
    if (head.byteLength < 16) continue;
    for (const key of keys) {
      try {
        if (keyMatchesHeader(key.cipher, head)) {
          matched.push({ id: target.id, ekey: key.ekey });
          break;
        }
      } catch {
        // 单把密钥异常不影响其它候选
      }
    }
    postProgress('match', t + 1, targets.length, keys.length, matched.length);
  }

  const result: ScanResult = {
    matched,
    stats: {
      filesScanned,
      filesSkipped,
      bytesRead,
      candidates: candidates.size,
      keys: keys.length,
      elapsedMs: Date.now() - started,
    },
  };
  ctx.postMessage({ type: 'done', ...result });
}
