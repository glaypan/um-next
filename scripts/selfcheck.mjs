/**
 * 内核自检入口：用 esbuild 打包 `scripts/selfcheck.ts` 后在 Node 里直接执行。
 * 之所以不直接 `tsx`，是为了不额外引入运行时依赖（esbuild 已是 vite 的依赖）。
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.resolve(here, '../.tmp/selfcheck.bundle.mjs');

await build({
  entryPoints: [path.resolve(here, 'selfcheck.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning',
});

await import(pathToFileURL(outfile).href);
