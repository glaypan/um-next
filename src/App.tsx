import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DropZone from './ui/DropZone';
import FileRow from './ui/FileRow';
import FormatHelp, { FormatTable } from './ui/FormatHelp';
import KeyDialog from './ui/KeyDialog';
import VaultPanel from './ui/VaultPanel';
import FolderImport, { type MatchedKeyRecord } from './ui/FolderImport';
import { mimeForExt } from './core/audio';
import { stripExtension } from './core/filename';
import type { DecryptOutcome } from './core/types';
import {
  addVaultEntry,
  loadVault,
  saveVault,
  toVaultSnapshot,
  type VaultData,
  type VaultKind,
} from './store/vault';
import { downloadBytes } from './store/download';
import {
  buildCoverFileName,
  buildFileName,
  createQueueItem,
  type QueueItem,
} from './store/queue';
import { DecryptAbortError, decryptClient } from './worker/client';

const THEME_KEY = 'um-next:theme';
type Theme = 'light' | 'dark';

/**
 * 内存护栏阈值。
 *
 * 解密结果是整个音频字节（可能上百 MB），全部留在内存里等用户点下载。
 * 超过 512 MiB 提示用户下载后移除；超过 1 GiB 拒绝新文件入队——
 * 只提示、不自动删数据，避免把用户还没下载的东西丢掉（P2-3）。
 */
const MEMORY_WARN_BYTES = 512 * 1024 * 1024;
const MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;

function initialTheme(): Theme {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* localStorage 不可用时忽略 */
  }
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}



/**
 * 记忆 ekey 时选哪个标识：优先 media_filename（最精确），其次 mid，
 * 最后回退「本地文件名去扩展名」——改过后缀（.mflac/.mgg）也能重新命中。
 * 与 detect.resolveEkeyFromVault 的查找顺序严格对应。
 */
function rememberTarget(item: QueueItem): { kind: VaultKind; identifier: string } | null {
  const info = item.keyInfo;
  if (info?.mediaFilename) return { kind: 'filename', identifier: info.mediaFilename };
  if (info?.mid) return { kind: 'mid', identifier: info.mid };
  const base = stripExtension(item.name);
  return base ? { kind: 'basename', identifier: base } : null;
}

export default function App() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [vault, setVault] = useState<VaultData>(() => loadVault());
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [formatOpen, setFormatOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [folderImportOpen, setFolderImportOpen] = useState(false);
  const [keyDialogId, setKeyDialogId] = useState<string | null>(null);
  const [keyError, setKeyError] = useState('');
  /** 状态变化后踢一下调度 effect，避免「正在运行」标志与批处理打架。 */
  const [tick, setTick] = useState(0);
  /** 因内存上限被拒绝入队的文件数（0 表示没有发生拒绝）。 */
  const [memoryRejected, setMemoryRejected] = useState(0);

  const runningRef = useRef(false);
  const vaultRef = useRef(vault);
  const manualKeys = useRef(new Map<string, { ekey: string; remember: boolean }>());
  /** 用户主动关掉过弹窗的条目，避免下一次状态变化又弹出来。 */
  const dismissedKeyPrompt = useRef(new Set<string>());
  /** 当前运行令牌：取消/新一轮运行后，旧任务的 finally 不得清掉新任务的「运行中」标志。 */
  const runToken = useRef(0);

  useEffect(() => {
    vaultRef.current = vault;
    saveVault(vault);
  }, [vault]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      globalThis.localStorage?.setItem(THEME_KEY, theme);
    } catch {
      /* 忽略 */
    }
  }, [theme]);

  const patch = useCallback((id: string, changes: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }, []);

  const applyOutcome = useCallback(
    (item: QueueItem, outcome: DecryptOutcome, manualEkey: string | undefined, remember: boolean) => {
      switch (outcome.status) {
        case 'ok': {
          patch(item.id, {
            status: 'done',
            progress: 1,
            data: outcome.data,
            ext: outcome.ext,
            cipher: outcome.cipher,
            meta: outcome.meta,
            cover: outcome.cover,
            warnings: outcome.warnings,
            message: undefined,
            keySource: outcome.keySource,
          });
          setKeyDialogId((current) => (current === item.id ? null : current));
          setKeyError('');
          if (manualEkey && remember) {
            const target = rememberTarget(item);
            if (target) {
              setVault((prev) => addVaultEntry(prev, target.kind, target.identifier, manualEkey));
            }
          }
          return;
        }
        case 'need-key': {
          patch(item.id, {
            status: 'need-key',
            progress: 0,
            keyInfo: outcome.info,
            message: undefined,
            warnings: outcome.warnings,
          });
          setKeyError('');
          return;
        }
        case 'bad-key': {
          patch(item.id, {
            status: 'failed',
            progress: 0,
            warnings: outcome.warnings,
            message: '密钥无效或与该文件不匹配',
          });
          if (manualEkey) {
            // 用户手输的密钥不对：把弹窗留着并给出明确提示
            setKeyError('密钥无效或与该文件不匹配，请检查是否复制完整');
            setKeyDialogId(item.id);
          }
          return;
        }
        case 'unsupported': {
          patch(item.id, {
            status: 'failed',
            progress: 0,
            warnings: outcome.warnings,
            message: outcome.reason,
          });
          return;
        }
      }
    },
    [patch],
  );

  const runItem = useCallback(
    async (item: QueueItem, token: number, manualEkey?: string, remember = false) => {
      patch(item.id, { status: 'running', progress: 0, message: undefined });
      try {
        const outcome = await decryptClient.decrypt(item.file, {
          fileName: item.name,
          ekey: manualEkey,
          vault: toVaultSnapshot(vaultRef.current),
          onProgress: (ratio) => {
            if (runToken.current === token) patch(item.id, { progress: ratio });
          },
        });
        // 迟到的结果（已取消 / 已被新一轮取代）一律丢弃，绝不覆盖新状态
        if (runToken.current !== token) return;
        applyOutcome(item, outcome, manualEkey, remember);
      } catch (error) {
        if (runToken.current !== token) return;
        if (error instanceof DecryptAbortError) {
          patch(item.id, { status: 'cancelled', progress: 0, message: '已取消' });
        } else {
          patch(item.id, {
            status: 'failed',
            progress: 0,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (runToken.current === token) {
          runningRef.current = false;
          setTick((value) => value + 1);
        }
      }
    },
    [applyOutcome, patch],
  );

  // 串行调度：一次只解一个文件，内存峰值可控
  useEffect(() => {
    if (runningRef.current) return;
    const next = queue.find((item) => item.status === 'pending');
    if (!next) return;
    runningRef.current = true;
    const token = ++runToken.current;
    const manual = manualKeys.current.get(next.id);
    manualKeys.current.delete(next.id);
    void runItem(next, token, manual?.ekey, manual?.remember ?? false);
  }, [queue, tick, runItem]);

  // 补密钥弹窗调度：只要还有「需要密钥」且没被用户关掉的条目，就弹出来
  useEffect(() => {
    // 自动导入弹窗打开时不要再把补密钥弹窗叠在下面（两个 modal 叠层会互相遮挡）
    if (keyDialogId !== null || folderImportOpen) return;
    const next = queue.find(
      (item) => item.status === 'need-key' && !dismissedKeyPrompt.current.has(item.id),
    );
    if (next) {
      setKeyError('');
      setKeyDialogId(next.id);
    }
  }, [queue, keyDialogId, folderImportOpen]);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    if (doneBytesRef.current >= MEMORY_LIMIT_BYTES) {
      // 已达上限：只拒绝新文件并提示，不动已经在队列里的数据
      setMemoryRejected(files.length);
      return;
    }
    setMemoryRejected(0);
    setQueue((prev) => [...prev, ...files.map(createQueueItem)]);
  }, []);

  const handleCancel = useCallback(
    (item: QueueItem) => {
      decryptClient.cancel();
      runToken.current += 1;
      runningRef.current = false;
      patch(item.id, { status: 'cancelled', progress: 0, message: '已取消' });
      setTick((value) => value + 1);
    },
    [patch],
  );

  const handleRemove = useCallback(
    (item: QueueItem) => {
      if (item.status === 'running') {
        decryptClient.cancel();
        runToken.current += 1;
        runningRef.current = false;
        setTick((value) => value + 1);
      }
      setQueue((prev) => prev.filter((entry) => entry.id !== item.id));
      if (keyDialogId === item.id) setKeyDialogId(null);
    },
    [keyDialogId],
  );

  const handleRetry = useCallback(
    (item: QueueItem) => {
      patch(item.id, { status: 'pending', progress: 0, message: undefined });
    },
    [patch],
  );

  const handleVaultChange = useCallback((next: VaultData) => {
    setVault(next);
    // 保险库变化后，把「需要密钥」的条目重新排队——命中就能自动解开
    setQueue((prev) =>
      prev.map((item) => (item.status === 'need-key' ? { ...item, status: 'pending' } : item)),
    );
  }, []);

  /**
   * 目录扫描命中后的处理：只重排**真正匹配到密钥**的条目。
   * 不做「全部 need-key 重来」——否则没匹配上的文件会白跑一轮解密。
   */
  const handleAutoMatched = useCallback((records: MatchedKeyRecord[]) => {
    if (records.length === 0) return;
    let next = vaultRef.current;
    const matchedIds = new Set<string>();
    for (const record of records) {
      next = addVaultEntry(next, record.kind, record.identifier, record.ekey);
      matchedIds.add(record.id);
    }
    setVault(next);
    setQueue((prev) =>
      prev.map((item) =>
        matchedIds.has(item.id) && item.status === 'need-key'
          ? { ...item, status: 'pending', progress: 0, message: undefined }
          : item,
      ),
    );
    setKeyDialogId((current) => (current && matchedIds.has(current) ? null : current));
    setKeyError('');
  }, []);

  const submitEkey = useCallback(
    (ekey: string, remember: boolean) => {
      if (!keyDialogId) return;
      const item = queue.find((entry) => entry.id === keyDialogId);
      if (!item) return;
      manualKeys.current.set(item.id, { ekey, remember });
      dismissedKeyPrompt.current.delete(item.id);
      setKeyDialogId(null);
      setKeyError('');
      patch(item.id, { status: 'pending', progress: 0, message: undefined });
    },
    [keyDialogId, patch, queue],
  );

  const downloadItem = useCallback((item: QueueItem) => {
    if (!item.data) return;
    downloadBytes(item.data, buildFileName(item), mimeForExt(item.ext ?? ''));
  }, []);

  const downloadCover = useCallback((item: QueueItem) => {
    if (!item.cover) return;
    downloadBytes(item.cover.data, buildCoverFileName(item), item.cover.mime);
  }, []);

  const doneItems = useMemo(
    () => queue.filter((item) => item.status === 'done' && item.data),
    [queue],
  );

  const doneBytes = useMemo(
    () =>
      queue.reduce(
        (sum, item) => sum + (item.status === 'done' && item.data ? item.data.byteLength : 0),
        0,
      ),
    [queue],
  );
  const memoryFull = doneBytes >= MEMORY_LIMIT_BYTES;
  const memoryWarn = doneBytes > MEMORY_WARN_BYTES;
  const doneBytesRef = useRef(0);
  useEffect(() => {
    doneBytesRef.current = doneBytes;
  }, [doneBytes]);
  // 内存回落后清掉「刚被拒绝」的提示，避免文案一直挂着
  useEffect(() => {
    if (!memoryFull) setMemoryRejected(0);
  }, [memoryFull]);

  const downloadAll = useCallback(() => {
    doneItems.forEach((item, index) => {
      window.setTimeout(() => downloadItem(item), index * 350);
    });
  }, [doneItems, downloadItem]);

  const keyDialogItem = queue.find((item) => item.id === keyDialogId) ?? null;
  const busy = queue.some((item) => item.status === 'running');

  return (
    <div className="app">
      <header className="header">
        <div className="header__titles">
          <h1 className="header__title">UM Next · 音乐解锁</h1>
          <p className="header__subtitle">支持 QQ 音乐 MusicEx/STag · 网易云 NCM 3.x</p>
        </div>
        <div className="header__actions">
          <button type="button" className="btn btn--small" onClick={() => setFormatOpen(true)}>
            格式说明
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setFolderImportOpen(true)}
            title="选择一个本地文件夹，自动扫描其中的 ekey 并匹配待解文件"
          >
            自动导入密钥
          </button>
          <button type="button" className="btn btn--small" onClick={() => setVaultOpen(true)}>
            保险库{vault.entries.length > 0 ? `（${vault.entries.length}）` : ''}
          </button>
          <button
            type="button"
            className="btn btn--small"
            aria-label={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? '深色' : '浅色'}
          </button>
        </div>
      </header>

      <main className="main">
        <DropZone onFiles={addFiles} />

        {memoryWarn ? (
          <p className={memoryFull ? 'notice notice--danger' : 'notice'} role="status">
            <strong>已完成文件占用内存较多，建议下载后移除。</strong>
            {memoryFull
              ? ` 已达到 1 GiB 上限（当前 ${Math.round(doneBytes / 1024 / 1024)} MB），暂时无法添加新文件。`
              : ` 当前约 ${Math.round(doneBytes / 1024 / 1024)} MB。`}
            {memoryRejected > 0 ? ` 已忽略本次拖入的 ${memoryRejected} 个文件。` : ''}
          </p>
        ) : null}

        {queue.length === 0 ? (
          <section className="empty" aria-label="支持的格式">
            <h2 className="section-title">支持的格式</h2>
            <FormatTable />
            <p className="empty__note">
              把文件拖进上面的区域即可开始。所有解密都在你的浏览器里完成，文件与 ekey 都不会离开本机。
            </p>
          </section>
        ) : (
          <section className="queue" aria-label="待处理文件">
            <div className="queue__toolbar">
              <h2 className="section-title">
                队列 <span className="queue__count">{queue.length}</span>
                {doneItems.length > 0 ? (
                  <span className="queue__count queue__count--ok">已完成 {doneItems.length}</span>
                ) : null}
              </h2>
              <div className="queue__actions">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={downloadAll}
                  disabled={doneItems.length === 0}
                >
                  下载全部
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={() => {
                    if (busy) {
                      decryptClient.cancel();
                      runToken.current += 1;
                      runningRef.current = false;
                    }
                    setQueue((prev) =>
                      prev.filter((item) => item.status === 'running' || item.status === 'pending'),
                    );
                    setTick((value) => value + 1);
                  }}
                  disabled={queue.length === 0}
                >
                  清除已结束
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={() => {
                    if (busy) {
                      decryptClient.cancel();
                      runToken.current += 1;
                      runningRef.current = false;
                    }
                    setQueue([]);
                    setKeyDialogId(null);
                    setTick((value) => value + 1);
                  }}
                >
                  清空队列
                </button>
              </div>
            </div>

            <ul className="row-list">
              {queue.map((item) => (
                <FileRow
                  key={item.id}
                  item={item}
                  onDownload={downloadItem}
                  onDownloadCover={downloadCover}
                  onNeedKey={(target) => {
                    setKeyError('');
                    setKeyDialogId(target.id);
                  }}
                  onRemove={handleRemove}
                  onCancel={handleCancel}
                  onRetry={handleRetry}
                />
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="footer">
        <p className="footer__primary">本地解密，不上传 · 无网络请求 · 不写 cookie</p>
        <p>
          仅用于处理你自己已购买或已下载的文件。本工具不提供任何密钥，不绕过账号、付费或版权校验；
          请遵守你所在地区的法律与服务条款。
        </p>
        <p className="footer__muted">
          ekey 只保存在本机 localStorage（可随时在「保险库」中清空）。队列中的文件名不会发送到任何服务器。
        </p>
      </footer>

      <KeyDialog
        open={keyDialogItem !== null}
        item={keyDialogItem}
        error={keyError}
        onClose={() => {
          if (keyDialogId) dismissedKeyPrompt.current.add(keyDialogId);
          setKeyDialogId(null);
          setKeyError('');
        }}
        onSubmit={submitEkey}
        onAutoImport={() => {
          // 不把当前条目标记为「用户主动关闭」，扫描成功后它会被重新排队
          setKeyDialogId(null);
          setKeyError('');
          setFolderImportOpen(true);
        }}
      />
      <FolderImport
        open={folderImportOpen}
        items={queue.filter((item) => item.status === 'need-key')}
        onClose={() => setFolderImportOpen(false)}
        onMatched={handleAutoMatched}
      />
      <VaultPanel
        open={vaultOpen}
        data={vault}
        onChange={handleVaultChange}
        onClose={() => setVaultOpen(false)}
      />
      <FormatHelp open={formatOpen} onClose={() => setFormatOpen(false)} />
    </div>
  );
}
