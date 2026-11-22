/**
 * ekey 保险库（localStorage）。
 *
 * 只存「标识 → ekey」，标识来自文件尾部（MusicEx 的 media_filename / STag 的 media_mid），
 * 或用户文件名，不含任何路径与个人信息。键名固定 `um-next:vault:v1`。
 *
 * 匹配优先级由 detect.ts 决定：mediaFilename → mid → 文件名 basename。
 */
import type { VaultSnapshot } from '../core/types';

export const VAULT_STORAGE_KEY = 'um-next:vault:v1';

export type VaultKind = 'filename' | 'mid' | 'basename';

export interface VaultRecord {
  kind: VaultKind;
  identifier: string;
  ekey: string;
  updatedAt: number;
}

export interface VaultData {
  version: 1;
  entries: VaultRecord[];
}

export const EMPTY_VAULT: VaultData = { version: 1, entries: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 读取保险库；任何异常（禁用 localStorage / 数据损坏）都退化为空库，不让 UI 崩。 */
export function loadVault(): VaultData {
  try {
    const raw = globalThis.localStorage?.getItem(VAULT_STORAGE_KEY);
    if (!raw) return { ...EMPTY_VAULT, entries: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
      return { ...EMPTY_VAULT, entries: [] };
    }
    const entries: VaultRecord[] = [];
    for (const item of parsed.entries) {
      if (!isRecord(item)) continue;
      const kind = item.kind;
      const identifier = item.identifier;
      const ekey = item.ekey;
      if (kind !== 'filename' && kind !== 'mid' && kind !== 'basename') continue;
      if (typeof identifier !== 'string' || identifier.length === 0) continue;
      if (typeof ekey !== 'string' || ekey.length === 0) continue;
      entries.push({
        kind,
        identifier,
        ekey,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
      });
    }
    return { version: 1, entries };
  } catch {
    return { ...EMPTY_VAULT, entries: [] };
  }
}

/** 写入保险库（失败静默：无痕模式下 localStorage 可能只读）。 */
export function saveVault(data: VaultData): boolean {
  try {
    globalThis.localStorage?.setItem(VAULT_STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** 新增/覆盖一条记录（同 kind + identifier 视为同一条）。返回新对象，不修改入参。 */
export function addVaultEntry(
  data: VaultData,
  kind: VaultKind,
  identifier: string,
  ekey: string,
): VaultData {
  const trimmedId = identifier.trim();
  const trimmedKey = ekey.trim();
  if (!trimmedId || !trimmedKey) return data;
  const entries = data.entries.filter(
    (entry) => !(entry.kind === kind && entry.identifier === trimmedId),
  );
  entries.unshift({ kind, identifier: trimmedId, ekey: trimmedKey, updatedAt: Date.now() });
  return { version: 1, entries };
}

export function removeVaultEntry(data: VaultData, kind: VaultKind, identifier: string): VaultData {
  return {
    version: 1,
    entries: data.entries.filter(
      (entry) => !(entry.kind === kind && entry.identifier === identifier),
    ),
  };
}

export function clearVaultData(): VaultData {
  return { ...EMPTY_VAULT, entries: [] };
}

/**
 * 转成 Worker 需要的快照（三个查找表）。
 *
 * 用 `Object.create(null)` 而不是 `{}`：标识来自文件名/mid，用户完全可以存出
 * `__proto__`、`constructor`、`toString` 之类的键，普通对象上赋值/取值会命中或污染原型（P3-1）。
 */
export function toVaultSnapshot(data: VaultData): VaultSnapshot {
  const snapshot: VaultSnapshot = {
    byFilename: Object.create(null) as Record<string, string>,
    byMid: Object.create(null) as Record<string, string>,
    byBasename: Object.create(null) as Record<string, string>,
  };
  // 后写入的优先：entries 是新记录在前，因此从后往前覆盖
  for (let i = data.entries.length - 1; i >= 0; i--) {
    const entry = data.entries[i];
    // `__proto__` 在结构化克隆后会退化成普通属性，但存储侧一律不接受，避免任何歧义
    if (entry.identifier === '__proto__') continue;
    const target =
      entry.kind === 'filename'
        ? snapshot.byFilename
        : entry.kind === 'mid'
          ? snapshot.byMid
          : snapshot.byBasename;
    target[entry.identifier] = entry.ekey;
  }
  return snapshot;
}

/** ekey 掩码显示（保留首尾便于用户核对）。 */
export function maskEkey(ekey: string): string {
  if (ekey.length <= 10) return `${ekey.slice(0, 2)}…${ekey.slice(-2)}`;
  return `${ekey.slice(0, 6)}…${ekey.slice(-4)}`;
}

/** 猜一个标识的 kind：带扩展名 → filename，否则按 mid 处理。 */
export function guessKind(identifier: string): VaultKind {
  return /[.][A-Za-z0-9]{1,6}$/.test(identifier.trim()) ? 'filename' : 'mid';
}

/**
 * 导入文本，每行 `标识,ekey`；也接受 `kind,标识,ekey`（kind ∈ filename|mid|basename）。
 * 返回新数据与统计信息。
 */
export function importVaultText(
  data: VaultData,
  text: string,
): { next: VaultData; added: number; skipped: number } {
  let next = data;
  let added = 0;
  let skipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',').map((part) => part.trim());
    let kind: VaultKind;
    let identifier: string;
    let ekey: string;
    if (parts.length >= 3 && (parts[0] === 'filename' || parts[0] === 'mid' || parts[0] === 'basename')) {
      kind = parts[0];
      identifier = parts[1];
      ekey = parts.slice(2).join(',');
    } else if (parts.length >= 2) {
      identifier = parts[0];
      ekey = parts.slice(1).join(',');
      kind = guessKind(identifier);
    } else {
      skipped++;
      continue;
    }
    if (!identifier || !ekey) {
      skipped++;
      continue;
    }
    next = addVaultEntry(next, kind, identifier, ekey);
    added++;
  }
  return { next, added, skipped };
}

/** 导出为格式化 JSON（便于备份与手工编辑）。 */
export function exportVaultText(data: VaultData): string {
  return JSON.stringify(data, null, 2);
}
