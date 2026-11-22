/** 跨模块共享的类型定义。内核函数返回这些结构，UI / Worker 只负责展示与传输。 */

export type CipherName = 'QMC1' | 'QMC2/Map' | 'QMC2/RC4' | 'NCM' | 'AUDIO';

export interface TrackMeta {
  title?: string;
  artist?: string;
  album?: string;
  format?: string;
  bitrate?: number;
  duration?: number;
}

export interface CoverImage {
  mime: string;
  data: Uint8Array;
}

/**
 * 解密实际用到的密钥来源。
 *
 * 必须由内核按「真实走过的分支」如实标注，不能用 `options.ekey || vault` 之类合并判断——
 * UI 要告诉用户「这把钥匙是文件自带的 / 我保险库里存的 / 我这次手输的」。
 *
 * - `embedded`：文件尾部内嵌 ekey（QTag / PCv1Legacy）
 * - `vault`   ：本机保险库命中
 * - `manual`  ：用户手动输入
 * - `none`    ：不需要密钥（NCM / QMC1 / 已是明文）
 */
export type KeySource = 'embedded' | 'vault' | 'manual' | 'none';

/** 需要用户补 ekey 时给 UI 的定位信息。 */
export type KeyLookupKind =
  | 'qmc2-musicex'
  | 'qmc2-stag'
  | 'qmc2-qtag'
  | 'qmc2-pcv1'
  | 'qmc2-unknown';

export interface KeyLookupInfo {
  kind: KeyLookupKind;
  /** MusicEx mid / STag media_mid。 */
  mid?: string;
  /** MusicEx media_filename（也是保险库的首选匹配键）。 */
  mediaFilename?: string;
  /** STag / QTag 的 resource_id（字符串形式，避免超过 2^53 的极端值丢精度）。 */
  resourceId?: string;
  /** UI 建议展示/命名的文件名。 */
  suggestedName?: string;
}

/** 主线程传给 Worker 的保险库快照（结构化克隆，纯数据）。 */
export interface VaultSnapshot {
  byFilename: Record<string, string>;
  byMid: Record<string, string>;
  byBasename: Record<string, string>;
}

export interface DecryptOk {
  status: 'ok';
  /** 已裁剪尾部的明文音频（可能是入参 buffer 的视图，不要改写）。 */
  data: Uint8Array;
  ext: string;
  cipher: CipherName;
  meta?: TrackMeta;
  cover?: CoverImage;
  /** 这次解密实际用的密钥来源（UI 用来显示「文件内嵌 / 保险库 / 手输」）。 */
  keySource?: KeySource;
  /** 非致命问题（CRC 不匹配、封面缺失等），UI 可折叠展示。 */
  warnings: string[];
}

export interface DecryptNeedKey {
  status: 'need-key';
  info: KeyLookupInfo;
  /** 需要密钥时通常还不知道密钥长度，故 Map/RC4 无法确定，可能缺省。 */
  cipher?: CipherName;
  warnings: string[];
}

export interface DecryptBadKey {
  status: 'bad-key';
  info: KeyLookupInfo;
  cipher?: CipherName;
  reason: string;
  warnings: string[];
}

export interface DecryptUnsupported {
  status: 'unsupported';
  reason: string;
  warnings: string[];
}

export type DecryptOutcome =
  | DecryptOk
  | DecryptNeedKey
  | DecryptBadKey
  | DecryptUnsupported;

export interface DecryptOptions {
  /** 原始文件名（用于兜底命名与保险库的 basename 匹配）。 */
  fileName?: string;
  /** 用户手动输入的 ekey。 */
  ekey?: string;
  /** 保险库快照（可选）。 */
  vault?: VaultSnapshot;
  /** 进度回调，参数为 0..1；内核按 4 MiB 分块回调。 */
  onProgress?: (ratio: number) => void;
  /** 取消检查：返回 true 时内核抛 DecryptAbortedError。 */
  isAborted?: () => boolean;
}

/** 用户主动取消（Worker 内被捕获后回报 cancelled）。 */
export class DecryptAbortedError extends Error {
  constructor() {
    super('已取消');
    this.name = 'DecryptAbortedError';
  }
}
