import { useEffect, useRef, useState } from 'react';
import type { QueueItem } from '../store/queue';

interface KeyDialogProps {
  open: boolean;
  item: QueueItem | null;
  error?: string;
  onClose: () => void;
  onSubmit: (ekey: string, remember: boolean) => void;
  /** 打开「从文件夹自动导入」，省去手动找 key。 */
  onAutoImport?: () => void;
  /** 打开各平台密钥获取说明。 */
  onShowKeyGuide?: () => void;
}

/**
 * 补 ekey 弹窗。展示 media_filename / mid / resource_id，方便用户对上号；
 * 勾选「记住」后成功后写入保险库（失败的密钥不会被记录）。
 */
export default function KeyDialog({
  open,
  item,
  error,
  onClose,
  onSubmit,
  onAutoImport,
  onShowKeyGuide,
}: KeyDialogProps) {
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(true);
  const [pasteHint, setPasteHint] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue('');
    setPasteHint('');
    setRemember(true);
    const timer = window.setTimeout(() => areaRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open, item?.id]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open || !item) return null;

  const info = item.keyInfo;
  const trimmed = value.trim();

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setValue(text.trim());
        setPasteHint('');
      } else {
        setPasteHint('剪贴板是空的');
      }
    } catch {
      setPasteHint('浏览器拒绝读取剪贴板，请手动粘贴（Ctrl+V）');
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title" id="key-dialog-title">
          这个文件需要 ekey
        </h2>
        <p className="modal__desc">
          新版本 QQ 音乐（PC ≥ 19.57，含 22.x）把密钥从文件里移除了。请把购买/下载该歌曲时得到的 ekey 贴进来；
          也可以先点「从文件夹自动找密钥」，扫描客户端的 <code>QQMusicConfV3.dat</code> / mmkv 数据目录。
          {!info?.mediaFilename && !info?.mid && !info?.resourceId
            ? '这个文件里没有可用的歌曲标识，将按上方的「保存标识」记住密钥。'
            : ''}
        </p>

        <dl className="kv">
          <dt>文件名</dt>
          <dd title={item.name}>{item.name}</dd>
          {info?.mediaFilename ? (
            <>
              <dt>media_filename</dt>
              <dd className="mono">{info.mediaFilename}</dd>
            </>
          ) : null}
          {info?.mid ? (
            <>
              <dt>mid / media_mid</dt>
              <dd className="mono">{info.mid}</dd>
            </>
          ) : null}
          {info?.resourceId ? (
            <>
              <dt>resource_id</dt>
              <dd className="mono">{info.resourceId}</dd>
            </>
          ) : null}
          {!info?.mediaFilename && !info?.mid && !info?.resourceId && info?.suggestedName ? (
            <>
              <dt>保存标识</dt>
              <dd className="mono">{info.suggestedName}</dd>
            </>
          ) : null}
        </dl>

        <label className="field">
          <span className="field__label">ekey</span>
          <textarea
            ref={areaRef}
            className="field__textarea"
            rows={4}
            spellCheck={false}
            value={value}
            placeholder="粘贴 ekey（支持 v1 / v2，含 QQMusic EncV2,Key: 前缀也可以）"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>

        {onShowKeyGuide ? (
          <p className="hint">
            不知道去哪里找？<button type="button" className="link-button" onClick={onShowKeyGuide}>查看各平台密钥获取方式</button>
          </p>
        ) : null}

        <div className="modal__row">
          <button type="button" className="btn btn--small" onClick={pasteFromClipboard}>
            从剪贴板粘贴
          </button>
          {onAutoImport ? (
            <button type="button" className="btn btn--small btn--ghost" onClick={onAutoImport}>
              从文件夹自动找密钥
            </button>
          ) : null}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            记住（按歌曲保存到本机）
          </label>
        </div>

        {pasteHint ? <p className="hint">{pasteHint}</p> : null}
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={trimmed.length === 0}
            onClick={() => onSubmit(trimmed, remember)}
          >
            解密
          </button>
        </div>
      </div>
    </div>
  );
}
