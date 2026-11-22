/**
 * 容器识别 + 统一解密入口。
 *
 * 识别顺序（与上游 `Deciphers.ts` 一致，不可随意调整）：
 *   1. NCM（固定文件头）
 *   2. QMC 尾部（STag → QTag → MusicEx → PCv1Legacy）→ 内嵌 ekey 直接解；无 ekey 则查保险库，
 *      仍然没有就返回 need-key（PC ≥ 19.57 / Android ≥ 10.12 的样本属于这类，密钥不在文件里）
 *   3. QMC1（无签名，先试解 0x20 字节看像不像音频）
 *   4. 已经是明文音频 → 原样输出
 *   5. 其它 → unsupported
 *
 * 每个分支都在解密后用音频魔数验证；QMC 解出来不是音频一律判定 bad-key，
 * 绝不把错误密钥当成成功（否则用户会拿到一堆噪声文件，还会把错密钥写进保险库）。
 */
import { guessAudioFormat, looksLikeAudio } from './audio';
import { DecryptAbortedError } from './types';
import type {
  CipherName,
  DecryptOk,
  DecryptOptions,
  DecryptOutcome,
  KeyLookupInfo,
  KeySource,
  TrackMeta,
  VaultSnapshot,
} from './types';
import { NcmParseError, NcmTruncatedError, hasNcmMagic, parseNcm } from './ncm/index';
import { decryptQMC1 } from './qmc/qmc1';
import { createQmc2Cipher, type Qmc2CipherKind } from './qmc/qmc2';
import { decryptEkey } from './qmc/ekey';
import { keyInfoFromFooter, parseQmcFooter } from './qmc/index';
import type { QmcFooter } from './qmc/footer';
import { basename, stripExtension } from './filename';
import { hasOwn } from './compat';

// 兼容既有调用方（测试/UI 都从 detect 取 basename）
export { basename };

/** 尾部探测窗口。 */
const TAIL_PROBE_SIZE = 4096;
/** 分块大小：4 MiB，兼顾进度粒度与内存峰值。 */
export const CHUNK_SIZE = 4 * 1024 * 1024;
/**
 * 探测长度。
 *
 * 不能太小：MP3 的帧长典型值 417 B（128 kbps / 44.1 kHz），只有拿到 2 帧数据才能做
 * 「下一帧也是合法帧头」的交叉校验，从而把随机字节误判成 MP3 的概率从 ~1/5000 降到可忽略。
 * 4 KiB 覆盖绝大多数帧长×2，解密成本可忽略（随后本来就要解整个文件）。
 */
const PROBE_SIZE = 4096;

const KNOWN_AUDIO_EXTS = new Set(['mp3', 'flac', 'ogg', 'm4a', 'wav', 'ape', 'wv', 'dsf']);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 保险库查找：`mediaFilename` → `mid` → 文件名 basename。
 * 逐级回退，且大小写不敏感（用户手输 ekey 时的标识常有大小写差异）。
 */
export function resolveEkeyFromVault(
  vault: VaultSnapshot | undefined,
  info: KeyLookupInfo,
  fileName: string | undefined,
): string | undefined {
  if (!vault) return undefined;
  const base = basename(fileName);
  // 保存键用「去扩展名的 basename」（改后缀也能命中），同时保留全名匹配以兼容旧记录
  const lookups: Array<[Record<string, string>, string | undefined]> = [
    [vault.byFilename, info.mediaFilename],
    [vault.byMid, info.mid],
    [vault.byBasename, base],
    [vault.byBasename, stripExtension(base)],
    [vault.byBasename, info.suggestedName],
  ];
  for (const [map, key] of lookups) {
    if (!key) continue;
    // 必须用 hasOwn：vault 来自 JSON / 结构化克隆，普通对象上 `map['constructor']`
    // 会取到原型链上的函数，被当成 ekey 传给解密（P3-1）。
    if (hasOwn(map, key)) {
      const direct = map[key];
      if (typeof direct === 'string' && direct.length > 0) return direct;
    }
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(map)) {
      if (k.toLowerCase() === lower && typeof v === 'string' && v.length > 0) return v;
    }
  }
  return undefined;
}

/** 决定输出扩展名：metadata.format 优先（且必须可信），否则用音频魔数推断。 */
function decideExt(meta: TrackMeta | undefined, data: Uint8Array): string {
  const detected = guessAudioFormat(data.subarray(0, Math.min(16, data.length)));
  const format = meta?.format?.toLowerCase();
  if (format && KNOWN_AUDIO_EXTS.has(format)) {
    // metadata 声明与实际容器冲突时以实际为准（3.x 出现过 format 字段不准）
    if (detected && detected.ext !== format) return detected.ext;
    return format;
  }
  return detected?.ext ?? 'bin';
}

function okFromPlain(
  data: Uint8Array,
  cipher: CipherName,
  meta: TrackMeta | undefined,
  warnings: string[],
  keySource: KeySource,
  cover?: DecryptOk['cover'],
): DecryptOk {
  return {
    status: 'ok',
    data,
    ext: decideExt(meta, data),
    cipher,
    meta,
    cover,
    keySource,
    warnings,
  };
}

function decryptNcmFile(buffer: Uint8Array, options: DecryptOptions): DecryptOutcome {
  try {
    const result = parseNcm(buffer, {
      onProgress: options.onProgress,
      isAborted: options.isAborted,
    });
    return {
      status: 'ok',
      data: result.data,
      ext: decideExt(result.meta, result.data),
      cipher: 'NCM',
      meta: result.meta,
      cover: result.cover,
      keySource: 'none',
      warnings: result.warnings,
    };
  } catch (err) {
    if (err instanceof DecryptAbortedError) throw err;
    if (err instanceof NcmTruncatedError) {
      // 「文件不完整」要和「格式不支持」区分开：前者用户重下即可，后者说明根本不是 NCM
      return {
        status: 'unsupported',
        reason: `NCM 解析失败：文件头不完整（可能未下载完成）— ${err.message}`,
        warnings: [],
      };
    }
    if (err instanceof NcmParseError) {
      return { status: 'unsupported', reason: `NCM 解析失败：${err.message}`, warnings: [] };
    }
    return { status: 'unsupported', reason: `NCM 解析失败：${errorMessage(err)}`, warnings: [] };
  }
}

interface Qmc2AttemptResult {
  ok: boolean;
  data?: Uint8Array;
  cipher?: CipherName;
  kind?: Qmc2CipherKind;
  reason?: string;
}

/**
 * 用给定 ekey 尝试解密 QMC2。
 *
 * 先用副本探测前 0x20 字节，确认像音频后才原地解密整个文件——
 * 这样「内嵌 ekey 失败 → 再试用户 ekey」的多轮尝试不会污染数据。
 */
function tryQmc2(
  buffer: Uint8Array,
  cropSize: number,
  ekey: string,
  options: DecryptOptions,
): Qmc2AttemptResult {
  let cipher;
  try {
    const key = decryptEkey(ekey);
    cipher = createQmc2Cipher(key);
  } catch (err) {
    return { ok: false, reason: `ekey 解析失败：${errorMessage(err)}` };
  }

  let view: Uint8Array;
  try {
    const crop = Math.max(0, Math.min(cropSize, buffer.length));
    view = buffer.subarray(0, buffer.length - crop);
    if (view.length === 0) return { ok: false, reason: '文件不含音频数据', kind: cipher.kind };

    const probe = view.slice(0, Math.min(PROBE_SIZE, view.length));
    cipher.decrypt(probe, 0);
    if (!looksLikeAudio(probe)) {
      return {
        ok: false,
        reason: '解密结果不是音频数据（ekey 无效或与该文件不匹配）',
        kind: cipher.kind,
      };
    }

    for (let pos = 0; pos < view.length; pos += CHUNK_SIZE) {
      if (options.isAborted?.()) throw new DecryptAbortedError();
      const end = Math.min(pos + CHUNK_SIZE, view.length);
      cipher.decrypt(view.subarray(pos, end), pos);
      options.onProgress?.(end / view.length);
    }
    return {
      ok: true,
      data: view,
      cipher: cipher.kind === 'map' ? 'QMC2/Map' : 'QMC2/RC4',
      kind: cipher.kind,
    };
  } catch (err) {
    if (err instanceof DecryptAbortedError) throw err;
    return { ok: false, reason: `QMC2 解密失败：${errorMessage(err)}`, kind: cipher?.kind };
  }
}

/** 整个文件按 QMC1 静态密钥解密（原地）。 */
function decryptQmc1Whole(buffer: Uint8Array, options: DecryptOptions): Uint8Array {
  for (let pos = 0; pos < buffer.length; pos += CHUNK_SIZE) {
    if (options.isAborted?.()) throw new DecryptAbortedError();
    const end = Math.min(pos + CHUNK_SIZE, buffer.length);
    decryptQMC1(buffer.subarray(pos, end), pos);
    options.onProgress?.(end / buffer.length);
  }
  return buffer;
}

/**
 * 统一入口。`buffer` 会被**原地修改**（零拷贝分块解密），调用方如果需要保留原数据请先自行复制。
 */
export function decryptFile(buffer: Uint8Array, options: DecryptOptions = {}): DecryptOutcome {
  const warnings: string[] = [];

  if (buffer.length === 0) {
    return { status: 'unsupported', reason: '文件为空', warnings };
  }

  // 1) NCM（只看 8 字节 magic：被截断的 NCM 也要走这里，才能报「文件不完整」）
  if (hasNcmMagic(buffer)) return decryptNcmFile(buffer, options);

  // 2) QMC 尾部
  const tail = buffer.subarray(Math.max(0, buffer.length - TAIL_PROBE_SIZE));
  const footer: QmcFooter | null = parseQmcFooter(tail);
  if (footer) {
    const info = keyInfoFromFooter(footer, options.fileName);
    const embeddedEkey = footer.kind === 'qtag' || footer.kind === 'pcv1' ? footer.ekey : undefined;
    // 手输与保险库分开判断：keySource 必须反映真实来源
    const manualEkey = options.ekey?.trim();
    const vaultEkey = manualEkey
      ? undefined
      : resolveEkeyFromVault(options.vault, info, options.fileName);

    const candidates: Array<{ ekey: string; crop: number; source: KeySource }> = [];
    if (embeddedEkey) {
      candidates.push({ ekey: embeddedEkey, crop: footer.size, source: 'embedded' });
    }
    if (manualEkey && manualEkey !== embeddedEkey) {
      candidates.push({ ekey: manualEkey, crop: footer.size, source: 'manual' });
    }
    if (vaultEkey && vaultEkey !== embeddedEkey) {
      candidates.push({ ekey: vaultEkey, crop: footer.size, source: 'vault' });
    }

    if (candidates.length === 0) {
      // 防御：尾部可能是误判（比如恰好以 "STag" 结尾的明文音频）
      if (looksLikeAudio(buffer)) {
        return okFromPlain(
          buffer,
          'AUDIO',
          undefined,
          ['文件尾部命中 QMC 特征，但内容已是明文音频，按明文输出'],
          'none',
        );
      }
      return { status: 'need-key', info, warnings };
    }

    let lastReason = '解密结果不是音频数据（ekey 无效或与该文件不匹配）';
    let lastCipher: CipherName | undefined;
    for (const candidate of candidates) {
      const attempt = tryQmc2(buffer, candidate.crop, candidate.ekey, options);
      if (attempt.ok && attempt.data && attempt.cipher) {
        return okFromPlain(attempt.data, attempt.cipher, undefined, warnings, candidate.source);
      }
      if (attempt.reason) lastReason = attempt.reason;
      if (attempt.cipher) lastCipher = attempt.cipher;
      else if (attempt.kind) lastCipher = attempt.kind === 'map' ? 'QMC2/Map' : 'QMC2/RC4';
    }
    return { status: 'bad-key', info, cipher: lastCipher, reason: lastReason, warnings };
  }

  // 2b) 无尾部但用户给了 ekey：按「不裁剪」处理（QMC2 用户手输密钥路径）
  const manualEkey = options.ekey?.trim();
  if (manualEkey) {
    const attempt = tryQmc2(buffer, 0, manualEkey, options);
    if (attempt.ok && attempt.data && attempt.cipher) {
      return okFromPlain(attempt.data, attempt.cipher, undefined, warnings, 'manual');
    }
    return {
      status: 'bad-key',
      info: { kind: 'qmc2-unknown', suggestedName: stripExtension(basename(options.fileName)) },
      cipher: attempt.cipher ?? (attempt.kind === 'rc4' ? 'QMC2/RC4' : undefined),
      reason: attempt.reason ?? '解密失败',
      warnings,
    };
  }

  // 3) QMC1：试解前 0x20 字节
  if (buffer.length >= 16) {
    const probe = buffer.slice(0, Math.min(PROBE_SIZE, buffer.length));
    decryptQMC1(probe, 0);
    if (looksLikeAudio(probe)) {
      options.onProgress?.(0);
      const data = decryptQmc1Whole(buffer, options);
      return okFromPlain(data, 'QMC1', undefined, warnings, 'none');
    }
  }

  // 4) 明文音频
  if (looksLikeAudio(buffer)) {
    return okFromPlain(buffer, 'AUDIO', undefined, warnings, 'none');
  }

  // 5) 认不出来
  return {
    status: 'unsupported',
    reason: '无法识别的文件格式（既不是 NCM，也没有匹配到 QMC1 / QMC2 特征，且不是明文音频）',
    warnings,
  };
}
