import { useEffect, useState } from 'react';
import { downloadText } from '../store/download';
import {
  clearVaultData,
  exportVaultText,
  importVaultText,
  maskEkey,
  removeVaultEntry,
  type VaultData,
  type VaultKind,
} from '../store/vault';

interface VaultPanelProps {
  open: boolean;
  data: VaultData;
  onChange: (next: VaultData) => void;
  onClose: () => void;
}

const KIND_LABEL: Record<VaultKind, string> = {
  filename: '文件名',
  mid: 'mid',
  basename: '本地文件',
};

/** ekey 保险库面板：查看/显示/删除、导入（每行 `标识,ekey`）、导出 JSON、清空。 */
export default function VaultPanel({ open, data, onChange, onClose }: VaultPanelProps) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [importText, setImportText] = useState('');
  const [notice, setNotice] = useState('');
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNotice('');
    setImportText('');
    setShowImport(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleImport = () => {
    const { next, added, skipped } = importVaultText(data, importText);
    onChange(next);
    setNotice(`已导入 ${added} 条${skipped > 0 ? `，跳过 ${skipped} 行` : ''}`);
    setImportText('');
    setShowImport(false);
  };

  const handleExport = () => {
    downloadText(exportVaultText(data), 'um-next-vault.json');
    setNotice('已导出 JSON');
  };

  const handleClear = () => {
    if (data.entries.length === 0) return;
    if (!window.confirm('确定清空本机保存的全部 ekey？此操作不可撤销。')) return;
    onChange(clearVaultData());
    setNotice('已清空');
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title" id="vault-title">
          ekey 保险库（本机）
        </h2>
        <p className="modal__desc">
          只保存在这台设备的 localStorage，不上传。删除后需要重新输入 ekey。
        </p>

        {data.entries.length === 0 ? (
          <p className="hint">还没有保存任何 ekey。解密成功后勾选「记住」即可自动保存。</p>
        ) : (
          <ul className="vault-list">
            {data.entries.map((entry) => {
              const key = `${entry.kind}:${entry.identifier}`;
              const isRevealed = revealed.has(key);
              return (
                <li className="vault-item" key={key}>
                  <div className="vault-item__id">
                    <span className="tag">{KIND_LABEL[entry.kind]}</span>
                    <span className="mono vault-item__name" title={entry.identifier}>
                      {entry.identifier}
                    </span>
                  </div>
                  <code className="vault-item__key mono">
                    {isRevealed ? entry.ekey : maskEkey(entry.ekey)}
                  </code>
                  <div className="vault-item__actions">
                    <button
                      type="button"
                      className="btn btn--small"
                      aria-label={isRevealed ? '隐藏密钥' : '显示密钥'}
                      onClick={() => {
                        const next = new Set(revealed);
                        if (isRevealed) next.delete(key);
                        else next.add(key);
                        setRevealed(next);
                      }}
                    >
                      {isRevealed ? '隐藏' : '显示'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--small btn--danger"
                      aria-label={`删除 ${entry.identifier} 的密钥`}
                      onClick={() => onChange(removeVaultEntry(data, entry.kind, entry.identifier))}
                    >
                      删除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {showImport ? (
          <div className="field">
            <label className="field__label" htmlFor="vault-import">
              每行一条：<code className="mono">标识,ekey</code>（也支持 <code className="mono">filename|mid|basename,标识,ekey</code>）
            </label>
            <textarea
              id="vault-import"
              className="field__textarea"
              rows={4}
              spellCheck={false}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder={'F0M000112233445566.mflac,UVFNdXNpYyBFbmNWMiw...\n001y7CaR29k6YP,UVFNdXNpYyBFbmNWMiw...'}
            />
            <div className="modal__row">
              <button type="button" className="btn btn--primary btn--small" onClick={handleImport}>
                导入
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => setShowImport(false)}
              >
                收起
              </button>
            </div>
          </div>
        ) : null}

        {notice ? <p className="hint">{notice}</p> : null}

        <div className="modal__actions modal__actions--spread">
          <div className="modal__row">
            <button type="button" className="btn btn--small" onClick={() => setShowImport(!showImport)}>
              导入
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={handleExport}
              disabled={data.entries.length === 0}
            >
              导出 JSON
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger"
              onClick={handleClear}
              disabled={data.entries.length === 0}
            >
              清空
            </button>
          </div>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
