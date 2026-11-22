/**
 * 浏览器下载工具（App 与保险库面板共用，避免两处各写一套 anchor 逻辑）。
 */

/** Uint8Array → Blob（内核产出的视图底层一定是 ArrayBuffer，不会是 SharedArrayBuffer）。 */
export function blobOf(data: Uint8Array, type: string): Blob {
  return new Blob([data as unknown as BlobPart], { type });
}

/**
 * 触发浏览器下载。
 *
 * 顺序很重要：`appendChild` → `click()` → `remove()` → 释放 URL。
 * 未插入文档的 anchor 在部分浏览器（Firefox）不会触发下载。
 */
export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 让浏览器先接管下载，再释放 blob URL
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 下载字节。 */
export function downloadBytes(data: Uint8Array, fileName: string, mime: string): void {
  triggerDownload(blobOf(data, mime), fileName);
}

/** 下载文本（JSON 导出等）。 */
export function downloadText(text: string, fileName: string, mime = 'application/json'): void {
  triggerDownload(new Blob([text], { type: mime }), fileName);
}
