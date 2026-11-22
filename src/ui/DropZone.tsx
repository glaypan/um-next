import { useCallback, useRef, useState } from 'react';
import type { DragEvent } from 'react';

/**
 * 拖拽 / 选择文件区域。支持多选与文件夹拖入（递归读取 webkitGetAsEntry）。
 * 键盘可操作：Tab 聚焦后 Enter / Space 打开文件选择框。
 */
interface DropZoneProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

/** 递归展开拖入的目录。浏览器不支持 entry API 时退化为普通文件列表。 */
async function readEntry(entry: FileSystemEntry, out: File[], depth = 0): Promise<void> {
  if (depth > 8) return;
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(
        (f) => resolve(f),
        () => resolve(null),
      );
    });
    if (file) out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // Chrome 的 readEntries 每次最多返回 100 条，必须反复调用同一个 reader 直到返回空数组，
    // 否则拖入大目录会静默丢文件（P2-2）。
    const entries: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) => {
        reader.readEntries(
          (items) => resolve(items),
          () => resolve([]),
        );
      });
      if (batch.length === 0) break;
      entries.push(...batch);
      // 防御：异常目录结构下避免无限循环
      if (entries.length > 50_000) break;
    }
    for (const child of entries) await readEntry(child, out, depth + 1);
  }
}

export default function DropZone({ onFiles, disabled = false }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const openPicker = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (disabled) return;

      const dt = event.dataTransfer;
      const items = Array.from(dt.items ?? []);
      const canUseEntries = items.some((item) => typeof item.webkitGetAsEntry === 'function');

      const collected: File[] = [];
      if (canUseEntries) {
        for (const item of items) {
          if (item.kind !== 'file') continue;
          const entry = item.webkitGetAsEntry();
          if (!entry) continue;
          await readEntry(entry, collected);
        }
      }
      if (collected.length === 0) collected.push(...Array.from(dt.files ?? []));
      if (collected.length > 0) onFiles(collected);
    },
    [disabled, onFiles],
  );

  return (
    <div
      className={`dropzone${dragging ? ' dropzone--active' : ''}${disabled ? ' dropzone--disabled' : ''}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="拖拽或选择要解密的音乐文件"
      aria-disabled={disabled}
      onClick={openPicker}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPicker();
        }
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        multiple
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
      <div className="dropzone__icon" aria-hidden="true">
        ♪
      </div>
      <p className="dropzone__title">把文件拖到这里，或点击选择</p>
      <p className="dropzone__hint">支持多选与整个文件夹拖入 · 文件仅在本地解密，不会上传</p>
    </div>
  );
}
