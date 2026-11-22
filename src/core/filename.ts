/**
 * 文件名小工具。
 *
 * 单独成模块是为了避免 `detect.ts` ⇄ `qmc/index.ts` 的循环依赖：
 * detect 需要 `keyInfoFromFooter`，而尾部解析又需要文件名回退逻辑。
 */

/** 取路径中的文件名部分（兼容 Windows / POSIX 分隔符）。 */
export function basename(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const idx = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  return idx >= 0 ? fileName.slice(idx + 1) : fileName;
}

/**
 * 去掉最后一个扩展名（只处理 basename，不碰目录）。
 * `song.mflac` → `song`；隐藏文件 `.mflac` 原样返回。
 */
export function stripExtension(fileName: string | undefined): string | undefined {
  const base = basename(fileName);
  if (!base) return undefined;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
