/** 用 esbuild 打包并执行 scripts/samples.ts。 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.resolve(here, '../.tmp/samples.build.mjs');

await build({
  entryPoints: [path.resolve(here, 'samples.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning',
});

await import(pathToFileURL(outfile).href);
