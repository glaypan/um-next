/**
 * ekey 目录扫描：从用户选中的本地文件夹里「捞」出可用的 QQ 音乐 ekey。
 *
 * 为什么需要它：新版 MusicEx / STag 文件不内嵌密钥，密钥只存在客户端自己的
 * 数据库/缓存里。浏览器无权读进程内存，但用户可以把客户端数据目录交给网页
 * （File API 授权），我们扫描里面的文件即可。
 *
 * 三条设计原则：
 * 1. **不做格式假设**：QQ 音乐 PC 用 SQLite/LevelDB，安卓用 MMKV，版本一换就变。
 *    这里只按「字节里出现的 base64 串」提取，再让算法自己证明它是不是 ekey。
 * 2. **自证而非猜测**：候选串必须能被 tc_tea 成功解密、且解出的密钥长度合理，
 *    才算有效。随机 base64 通过这一步的概率极低。
 * 3. **配对也靠算法**：不依赖数据库里的字段名，直接拿候选密钥解密目标文件头，
 *    只有解出音频魔数才认。这样字段改名、表结构变化都不影响。
 */
import { looksLikeAudio } from './audio';
import { base64Decode, latin1Decode } from './bytes';
import { EKEY_V2_PLAIN_PREFIX, EKEY_V2_PREFIX, decryptEkey, normalizeEkey } from './qmc/ekey';
import { createQmc2Cipher, type Qmc2Cipher } from './qmc/qmc2';

/** 单个候选串长度上限（真实 ekey 通常 100~2000 字符）。 */
const MAX_EKEY_CHARS = 8192;
/** 每个文件最多收集多少个候选（防止二进制里海量 base64 拖垮内存）。 */
const MAX_CANDIDATES_PER_FILE = 2000;
/** 扫描分块：1 MiB + 8 KiB 重叠，避免候选串被块边界截断。 */
const SCAN_CHUNK = 1024 * 1024;
const SCAN_OVERLAP = 8192;

/** 看起来像 base64 的长串（v2 的明文前缀单独处理）。 */
const CANDIDATE_RE = /[A-Za-z0-9+/]{20,8192}={0,2}/g;
const PLAIN_V2_RE = /QQMusic EncV2,Key:[A-Za-z0-9+/]{16,8192}={0,2}/g;

function base64DecodedLength(chars: number, padding: number): number {
  return Math.floor((chars * 3) / 4) - padding;
}

function trailingPadding(value: string): number {
  if (value.endsWith('==')) return 2;
  if (value.endsWith('=')) return 1;
  return 0;
}

/**
 * 形状预筛：只做长度与分块合法性判断，不碰密码学。
 * 真正的判定在 {@link decodeEkeyCandidate}。
 */
export function looksLikeEkeyShape(raw: string): boolean {
  let value = raw.trim();
  if (value.length < 20 || value.length > MAX_EKEY_CHARS) return false;

  if (value.startsWith(EKEY_V2_PLAIN_PREFIX)) {
    value = EKEY_V2_PREFIX + value.slice(EKEY_V2_PLAIN_PREFIX.length);
  }

  if (value.startsWith(EKEY_V2_PREFIX)) {
    const rest = value.slice(EKEY_V2_PREFIX.length);
    if (rest.length % 4 === 1) return false;
    const bytes = base64DecodedLength(rest.length, trailingPadding(rest));
    return bytes >= 16 && bytes % 8 === 0;
  }

  if (value.length % 4 === 1) return false;
  const bytes = base64DecodedLength(value.length, trailingPadding(value));
  // v1：base64(8 字节 header + 8 字节对齐的 TEA 密文)
  return bytes >= 16 && (bytes - 8) % 8 === 0;
}

/**
 * 候选 → 真正的 QMC2 密钥。失败返回 null（不抛异常，扫描时大量候选都是噪声）。
 */
export function decodeEkeyCandidate(raw: string): Uint8Array | null {
  if (!looksLikeEkeyShape(raw)) return null;
  try {
    const key = decryptEkey(normalizeEkey(raw));
    // 真实密钥：8 字节 header + 若干 TEA 明文，通常 16~600 字节；上限放宽防御异常输入
    if (key.length < 1 || key.length > 8192) return null;
    return key;
  } catch {
    return null;
  }
}

function collectFromText(text: string, out: Set<string>, cap: number): void {
  CANDIDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CANDIDATE_RE.exec(text)) !== null) {
    const value = match[0];
    if (looksLikeEkeyShape(value)) {
      out.add(value);
      if (out.size >= cap) return;
    }
  }

  PLAIN_V2_RE.lastIndex = 0;
  while ((match = PLAIN_V2_RE.exec(text)) !== null) {
    const value = match[0];
    if (looksLikeEkeyShape(value)) {
      out.add(value);
      if (out.size >= cap) return;
    }
  }
}

/**
 * UTF-16LE 投影：SQLite / MMKV 常把字符串按 UTF-16 存，base64 字符之间夹 0x00。
 * 同时尝试奇偶两种对齐，避免字符串从奇数偏移开始。
 */
function utf16Projection(chunk: Uint8Array, offsetParity: 0 | 1): string {
  const chars: string[] = [];
  for (let i = offsetParity; i + 1 < chunk.length; i += 2) {
    const lo = chunk[i];
    const hi = chunk[i + 1];
    if (lo >= 0x20 && lo < 0x7f && hi === 0) {
      chars.push(String.fromCharCode(lo));
    } else {
      chars.push('\n');
    }
  }
  return chars.join('');
}

/**
 * 从一个文件的字节里提取候选 ekey。会同时扫描 latin1 视图与 UTF-16LE 投影。
 */
export function extractEkeyCandidates(bytes: Uint8Array, cap = MAX_CANDIDATES_PER_FILE): string[] {
  const out = new Set<string>();

  for (let start = 0; start < bytes.length && out.size < cap; start += SCAN_CHUNK) {
    const end = Math.min(start + SCAN_CHUNK + SCAN_OVERLAP, bytes.length);
    const chunk = bytes.subarray(start, end);
    collectFromText(latin1Decode(chunk), out, cap);
    if (out.size >= cap) break;
    collectFromText(utf16Projection(chunk, 0), out, cap);
    if (out.size >= cap) break;
    collectFromText(utf16Projection(chunk, 1), out, cap);
  }

  return [...out];
}

export interface ScannedKey {
  ekey: string;
  key: Uint8Array;
  cipher: Qmc2Cipher;
}

/**
 * 把一个候选 ekey 变成可直接试解的 cipher。失败返回 null。
 * cipher 构造（RC4 会生成 5632 字节 keystream）在配对时复用，避免重复计算。
 */
export function buildScannedKey(raw: string): ScannedKey | null {
  const key = decodeEkeyCandidate(raw);
  if (!key) return null;
  try {
    return { ekey: normalizeEkey(raw), key, cipher: createQmc2Cipher(key) };
  } catch {
    return null;
  }
}

/**
 * 用一把密钥尝试解密文件头。只有解出音频魔数才算命中——这是「配对」的唯一依据，
 * 不依赖数据库字段名或文件名。
 */
export function keyMatchesHeader(cipher: Qmc2Cipher, head: Uint8Array): boolean {
  if (head.length < 16) return false;
  const probe = head.slice(0, Math.min(head.length, 4096));
  cipher.decrypt(probe, 0);
  return looksLikeAudio(probe);
}

/** 从一段字节里直接找「能解开该文件头」的密钥（测试与单文件场景用）。 */
export function findKeyForHeader(bytes: Uint8Array, head: Uint8Array): string | null {
  for (const candidate of extractEkeyCandidates(bytes)) {
    const scanned = buildScannedKey(candidate);
    if (scanned && keyMatchesHeader(scanned.cipher, head)) return scanned.ekey;
  }
  return null;
}

/** base64 解码的薄封装，供扫描流程统计候选质量。 */
export function candidateByteLength(raw: string): number {
  try {
    return base64Decode(normalizeEkey(raw)).length;
  } catch {
    return 0;
  }
}
