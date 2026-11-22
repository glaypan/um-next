import { useEffect, useRef, useState } from 'react';
import { basename, stripExtension } from '../core/filename';
import { readBlobBuffer } from '../core/compat';
import type { ScanProgress, ScanResult } from '../worker/scan.worker';
import { scanClient } from '../worker/scanClient';
import type { QueueItem } from '../store/queue';
import type { VaultKind } from '../store/vault';

export interface MatchedKeyRecord {
  id: string;
  kind: VaultKind;
  identifier: string;
  ekey: string;
}

interface FolderImportProps {
  open: boolean;
  /** 队列里「需要密钥」的条目；扫描结果只与它们配对。 */
  items: QueueItem[];
  onClose: () => void;
  onMatched: (records: MatchedKeyRecord[]) => void;
}

/** 与 scan.worker 的过滤规则保持一致：媒体/压缩包/字体不可能存 ekey。 */
const SKIP_EXT =
  /\.(mp3|flac|ogg|m4a|wav|ape|wv|dsf|mflac|mgg|qmc[0-9a-z]*|ncm|kgm|kgg|kwm|vpr|mp4|mkv|avi|mov|wmv|flv|webm|jpg|jpeg|png|gif|webp|bmp|ico|tif|tiff|heic|ttf|otf|woff2?|eot|zip|rar|7z|gz|bz2|xz|iso|msi|exe|dll|sys|so|dylib|node)$/i;

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 3000;
const HEAD_BYTES = 4096;

function skipPath(path: string): boolean {
  return /(^|[\\/])(node_modules|\.git|\$Recycle\.Bin|System Volume Information)([\\/]|$)/i.test(path);
}

function identifierFor(item: QueueItem): { kind: VaultKind; identifier: string } | null {
  const info = item.keyInfo;
  if (info?.mediaFilename) return { kind: 'filename', identifier: info.mediaFilename };
  if (info?.mid) return { kind: 'mid', identifier: info.mid };
  const base = stripExtension(basename(item.name));
  if (base) return { kind: 'basename', identifier: base };
  return null;
}

const PHASE_LABEL: Record<ScanProgress['phase'], string> = {
  read: '读取文件',
  validate: '验证候选密钥',
  match: '与待解文件配对',
};

/**
 * 「选择目录 → 自动导入密钥」弹窗。
 *
 * 只读取用户显式选中的文件夹，文件不会离开本机；扫描在 Worker 中进行。
 * 结果不是「猜」出来的：候选必须能通过 tc_tea 解密，且能解开目标文件头才算命中。
 */
export default function FolderImport({ open, items, onClose, onMatched }: FolderImportProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState('');
  const [pickedCount, setPickedCount] = useState(0);

  useEffect(() => {
    if (!open) return;
    setRunning(false);
    setProgress(null);
    setResult(null);
    setError('');
    setPickedCount(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(timer);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      scanClient.cancel();
    };
  }, [open]);

  if (!open) return null;

  const targets = items.filter((item) => item.status === 'need-key' && item.keyInfo);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError('');
    setResult(null);
    setPickedCount(fileList.length);

    const candidates = Array.from(fileList)
      .filter((file) => !SKIP_EXT.test(file.name) && file.size > 0 && file.size <= MAX_FILE_BYTES)
      .map((file) => ({
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        file,
      }))
      .filter((entry) => !skipPath(entry.path));

    // QQ 音乐的密钥库/缓存优先读：目录里常有上千个文件，先读最可能含 ekey 的，
    // 避免命中 MAX_FILES 上限时反而漏掉 QQMusicConfV3.dat / mmkv。
    const priority = (path: string): number => {
      if (/QQMusicConfV3\.dat$/i.test(path)) return 0;
      if (/(^|[\\/])mmkv([\\/]|$)/i.test(path)) return 1;
      if (/\.(db|sqlite3?|mmkv|json|txt|ini|dat|bin|ldb|log|cache)$/i.test(path)) return 2;
      return 3;
    };
    const files = candidates
      .sort((a, b) => priority(a.path) - priority(b.path))
      .slice(0, MAX_FILES);

    if (files.length === 0) {
      setError('这个目录里没有可扫描的数据文件（媒体文件会被跳过），请选择 QQ 音乐的数据目录。');
      return;
    }

    const heads = await Promise.all(
      targets.map(async (item) => ({
        id: item.id,
        head: await readBlobBuffer(item.file.slice(0, HEAD_BYTES)),
      })),
    );

    setRunning(true);
    setProgress(null);
    try {
      const scanResult = await scanClient.run(files, heads, setProgress);
      setResult(scanResult);

      const records: MatchedKeyRecord[] = [];
      const seen = new Set<string>();
      for (const match of scanResult.matched) {
        const item = targets.find((entry) => entry.id === match.id);
        if (!item) continue;
        const target = identifierFor(item);
        if (!target) continue;
        const key = `${target.kind}\u0000${target.identifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({ id: item.id, ...target, ekey: match.ekey });
      }
      if (records.length > 0) onMatched(records);
      // 命中后稍作停留让用户看到统计，然后自动关闭，避免挡住队列操作
      if (records.length > 0) {
        closeTimer.current = window.setTimeout(onClose, 1200);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const percent = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  return (
    <div className="modal-backdrop" role="presentation" onClick={running ? undefined : onClose}>
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-import-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title" id="folder-import-title">
          从文件夹自动导入密钥
        </h2>
        <p className="modal__desc">
          选择 QQ 音乐（或其他客户端）的<strong>数据目录</strong>，本工具会在本机扫描其中的数据库/缓存文件，
          找出可用的 ekey，并自动匹配队列里「需要密钥」的文件。文件不会上传。
        </p>

        {targets.length === 0 ? (
          <p className="modal__desc modal__desc--warn">
            当前没有等待密钥的文件。请先把 .mflac / .mgg 拖进队列，看到「需要密钥」后再来扫描。
          </p>
        ) : (
          <p className="modal__desc">
            待匹配文件 <strong>{targets.length}</strong> 个。扫描只认「能解开该文件」的密钥，不会把猜测写进保险库。
          </p>
        )}

        <details className="folder-import__hint">
          <summary>常见目录位置</summary>
          <ul>
            <li>
              Windows：<code>%APPDATA%\Tencent\QQMusic</code>、安装目录下的 <code>Data</code> / <code>Cache</code>，
              以及根目录的 <code>QQMusicConfV3.dat</code>（新版客户端的密钥库）
            </li>
            <li>
              安卓（需 root 导出）：<code>/data/data/com.tencent.qqmusic/files/mmkv</code>
            </li>
            <li>也可以直接选你存放导出的 ekey 文本/JSON 的文件夹</li>
          </ul>
        </details>

        <input
          ref={inputRef}
          type="file"
          multiple
          // React 不认 webkitdirectory 的类型，用展开方式设置
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          className="folder-import__input"
          aria-label="选择要扫描的文件夹"
          onChange={(event) => {
            void handleFiles(event.target.files);
            event.target.value = '';
          }}
        />

        <div className="modal__row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={running || targets.length === 0}
            onClick={() => inputRef.current?.click()}
          >
            {running ? '正在扫描…' : '选择文件夹并开始扫描'}
          </button>
          {running && (
            <button type="button" className="btn btn--ghost" onClick={() => scanClient.cancel()}>
              取消扫描
            </button>
          )}
        </div>

        {pickedCount > 0 && (
          <p className="folder-import__meta">
            已选择 {pickedCount} 个文件
            {progress ? `，已读取 ${progress.files} 个，候选 ${progress.candidates} 个` : ''}
          </p>
        )}

        {running && progress && (
          <div className="folder-import__progress">
            <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <div className="progress__bar" style={{ width: `${percent}%` }} />
            </div>
            <span className="folder-import__phase">
              {PHASE_LABEL[progress.phase]} {progress.done}/{progress.total}（已找到 {progress.keys} 把有效密钥）
            </span>
          </div>
        )}

        {error && <p className="folder-import__error">{error}</p>}

        {result && (
          <div className="folder-import__result">
            <p>
              扫描完成：读取 <strong>{result.stats.filesScanned}</strong> 个文件（跳过 {result.stats.filesSkipped}），
              得到 <strong>{result.stats.candidates}</strong> 个候选、<strong>{result.stats.keys}</strong> 把有效密钥，
              匹配成功 <strong>{result.matched.length}</strong> 个文件。
            </p>
            {result.matched.length > 0 ? (
              <p className="folder-import__ok">已写入保险库并重新排队，稍等即可看到解密完成。</p>
            ) : (
              <p className="folder-import__warn">
                没有匹配到。可能原因：目录选错（应选客户端数据目录）、密钥由账号在线下发未落盘，或文件与密钥不配对。
              </p>
            )}
          </div>
        )}

        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose} disabled={running}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
