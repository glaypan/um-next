import type { QueueItem } from '../store/queue';
import { buildFileName, formatSize, statusLabel } from '../store/queue';

/** 密钥来源标签：让用户一眼看出这把钥匙是文件自带、保险库还是本次手输。 */
const KEY_SOURCE_LABEL: Record<string, string> = {
  embedded: '文件内嵌',
  vault: '保险库',
  manual: '手输',
};

interface FileRowProps {
  item: QueueItem;
  onDownload: (item: QueueItem) => void;
  onDownloadCover: (item: QueueItem) => void;
  onNeedKey: (item: QueueItem) => void;
  onRemove: (item: QueueItem) => void;
  onCancel: (item: QueueItem) => void;
  onRetry: (item: QueueItem) => void;
}

export default function FileRow({
  item,
  onDownload,
  onDownloadCover,
  onNeedKey,
  onRemove,
  onCancel,
  onRetry,
}: FileRowProps) {
  const percent = Math.round(Math.min(1, Math.max(0, item.progress)) * 100);
  const canDownload = item.status === 'done' && Boolean(item.data);
  const keySourceLabel =
    item.keySource && item.keySource !== 'none' ? KEY_SOURCE_LABEL[item.keySource] : undefined;
  const needsKey = item.status === 'need-key' || (item.status === 'failed' && Boolean(item.keyInfo));
  const canRetry = item.status === 'failed' || item.status === 'cancelled';

  return (
    <li className={`row row--${item.status}`}>
      <div className="row__main">
        <div className="row__headline">
          <span className="row__name" title={item.name}>
            {item.name}
          </span>
          <span className="row__meta">
            {formatSize(item.size)}
            {item.cipher ? ` · ${item.cipher}` : ''}
          </span>
        </div>

        <div className="row__status" aria-live="polite">
          <span className={`badge badge--${item.status}`}>{statusLabel(item)}</span>
          {keySourceLabel ? (
            <span className="tag tag--source" title={`密钥来源：${keySourceLabel}`}>
              钥匙：{keySourceLabel}
            </span>
          ) : null}
          {item.status === 'done' && item.meta?.title ? (
            <span className="row__title" title={buildFileName(item)}>
              {item.meta.artist ? `${item.meta.artist} - ` : ''}
              {item.meta.title}
            </span>
          ) : null}
          {needsKey && item.keyInfo ? (
            <span className="row__title">
              {item.keyInfo.mediaFilename ??
                item.keyInfo.mid ??
                item.keyInfo.resourceId ??
                item.keyInfo.suggestedName ??
                '未知标识'}
            </span>
          ) : null}
        </div>

        {item.status === 'running' || item.status === 'converting' ? (
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={`${item.name} 处理进度`}
          >
            <div className="progress__bar" style={{ width: `${percent}%` }} />
          </div>
        ) : null}

        {item.warnings.length > 0 ? (
          <ul className="row__warnings">
            {item.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="row__actions">
        {canDownload ? (
          <button type="button" className="btn btn--primary" onClick={() => onDownload(item)}>
            下载
          </button>
        ) : null}
        {canDownload && item.cover ? (
          <button type="button" className="btn" onClick={() => onDownloadCover(item)}>
            下载封面
          </button>
        ) : null}
        {needsKey ? (
          <button type="button" className="btn" onClick={() => onNeedKey(item)}>
            补密钥
          </button>
        ) : null}
        {canRetry && !needsKey ? (
          <button type="button" className="btn" onClick={() => onRetry(item)}>
            重试
          </button>
        ) : null}
        {item.status === 'running' || item.status === 'converting' ? (
          <button type="button" className="btn" onClick={() => onCancel(item)}>
            取消
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => onRemove(item)}
          aria-label={`从队列移除 ${item.name}`}
        >
          移除
        </button>
      </div>
    </li>
  );
}
