/**
 * 旧浏览器兼容层。
 *
 * 目标环境包含 macOS 10.14.6（Mojave）——它最高只能装 Safari 14.1，
 * 而 Safari 直到 15.4 才有 `Object.hasOwn`，直到 14 才补上 `Blob.arrayBuffer`
 * 的完整体验。这里用最保守的写法兜底，避免在旧 Safari 上直接抛错。
 */

/** `Object.hasOwn` 的兼容实现（Safari < 15.4 没有）。 */
export function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * 读取 Blob/File 的字节。
 *
 * Safari 13 及更早没有 `Blob.prototype.arrayBuffer`，退回 FileReader。
 * FileReader 在主线程与 Worker 中都可用。
 */
export function readBlobBuffer(blob: Blob): Promise<ArrayBuffer> {
  const maybe = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof maybe.arrayBuffer === 'function') {
    return maybe.arrayBuffer();
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
      } else {
        reject(new Error('读取文件失败：返回类型不是 ArrayBuffer'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsArrayBuffer(blob);
  });
}
