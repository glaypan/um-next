/**
 * 把 `npm run samples` 的产物固化为 E2E 可用的 fixtures。
 *
 * 运行：node tests/make-fixtures.mjs
 * 输入：`.tmp/samples/*`（由 scripts/samples.ts 生成，确定性字节）
 * 输出：`tests/fixtures/*` + `tests/fixtures/manifest.json`
 *
 * 说明（重要，供下游 Vic 阅读）：
 *  - 本脚本**不重新生成**样本内容，只做「复制 + 计算 sha256 + 写清单」，
 *    保证 fixtures 里的字节与 scripts/samples.ts 的真实输出逐字节一致，可回溯。
 *  - `manifest.json[].sha256` = **解密后明文音频**的 sha256（E2E 断言下载结果用）。
 *  - `manifest.json[].fileSha256` = 容器文件自身的 sha256（校验 fixtures 未被改动）。
 *  - scripts/samples.ts 对 6 个样本复用同一段 4096 字节假音频（首 4 字节 `fLaC`），
 *    因此 6 项的 `sha256` 相同是**预期行为**，不是脚本 bug；各项靠 `cipher` /
 *    `fileSha256` / `needsEkey` 区分。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const srcDir = path.join(projectRoot, '.tmp', 'samples');
const outDir = path.join(here, 'fixtures');

/** 与 scripts/samples.ts 保持一致（同一份 ekey 向量，39 字节 key → Map 路径）。 */
const SAMPLE_EKEY =
  'MTIzNDU2NzhN2csrbjHfIPH0BrVByijvtaAXJdb4Iy7P/ktYG6Wxly+Vz5sZ5nqDPUHoVBuuzSQ=';

/** 源文件 → fixture 名 + 期望元数据。顺序即 manifest 顺序。 */
const PLAN = [
  {
    from: 'ncm-sample.ncm',
    to: 'sample-ncm.ncm',
    cipher: 'NCM',
    ext: 'flac',
    needsEkey: false,
    ekeyFile: null,
    note: '含 metadata + 极小的假 JPEG 封面（frameLen=64）',
  },
  {
    from: 'qmc1-sample.qmcflac',
    to: 'sample-qmc1.qmcflac',
    cipher: 'QMC1',
    ext: 'flac',
    needsEkey: false,
    ekeyFile: null,
    note: '静态 128 字节密钥 XOR，无尾部',
  },
  {
    from: 'qtag-sample.mgg',
    to: 'sample-qmc-qtag.mgg',
    cipher: 'QMC2/Map',
    ext: 'flac',
    needsEkey: false,
    ekeyFile: null,
    note: 'QTag 尾部内嵌 ekey，可零输入自动解密',
  },
  {
    from: 'musicex-sample.mflac',
    to: 'sample-qmc-musicex.mflac',
    cipher: 'QMC2/Map',
    ext: 'flac',
    needsEkey: true,
    ekeyFile: 'sample-qmc-musicex.ekey.txt',
    note: 'MusicEx 尾部不带 ekey，必须补 ekey 或走保险库',
  },
  {
    from: 'stag-sample.mgg',
    to: 'sample-qmc-stag.mgg',
    cipher: 'QMC2/Map',
    ext: 'flac',
    needsEkey: true,
    ekeyFile: 'sample-qmc-stag.ekey.txt',
    note: 'STag 尾部只带 resourceId/mediaMid，必须补 ekey 或走保险库',
  },
  {
    from: 'plain-sample.flac',
    to: 'sample-plain.flac',
    cipher: 'AUDIO',
    ext: 'flac',
    needsEkey: false,
    ekeyFile: null,
    note: '已经是明文，应原样透传',
  },
];

if (!existsSync(srcDir) || PLAN.some((p) => !existsSync(path.join(srcDir, p.from)))) {
  console.log('未找到 .tmp/samples 产物，先执行 npm run samples …');
  execFileSync(process.execPath, [path.join(projectRoot, 'scripts', 'make-samples.mjs')], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
}

/** @param {string} file */
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

mkdirSync(outDir, { recursive: true });

// 所有样本共用同一段明文音频 → 明文 sha256 直接取自 plain-sample.flac
const plaintextSha256 = sha256(path.join(srcDir, 'plain-sample.flac'));
const plaintextSize = readFileSync(path.join(srcDir, 'plain-sample.flac')).length;

/** @type {any[]} */
const manifest = [];
for (const item of PLAN) {
  const src = path.join(srcDir, item.from);
  const dst = path.join(outDir, item.to);
  copyFileSync(src, dst);

  if (item.ekeyFile) {
    writeFileSync(path.join(outDir, item.ekeyFile), `${SAMPLE_EKEY}\n`, 'utf8');
  }

  manifest.push({
    file: item.to,
    // 解密后明文音频的 sha256（E2E 用它断言下载结果）
    sha256: plaintextSha256,
    ext: item.ext,
    needsEkey: item.needsEkey,
    ekeyFile: item.ekeyFile,
    cipher: item.cipher,
    // 以下为附加字段（便于定位问题、校验 fixtures 完整性）
    fileSha256: sha256(dst),
    size: readFileSync(dst).length,
    plaintextSize,
    note: item.note,
  });
}

writeFileSync(
  path.join(outDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

console.log(`fixtures 已写入 ${outDir}（${manifest.length} 项）`);
console.log(`明文音频 sha256：${plaintextSha256}（${plaintextSize} 字节）`);
for (const m of manifest) console.log(`  - ${m.file}  ${m.cipher}  needsEkey=${m.needsEkey}`);
