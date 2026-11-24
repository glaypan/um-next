import { useEffect, useState, type ReactNode } from 'react';

interface KeyGuideProps {
  open: boolean;
  onClose: () => void;
  onAutoImport: () => void;
}

type Platform = 'windows' | 'mac' | 'android' | 'ios';

const RELEASE_URL = 'https://git.unlock-music.dev/um/um-react/releases/tag/v0.5.0';
const WIN_1951 = 'https://web.archive.org/web/2023/https://dldir1v6.qq.com/music/clntupate/QQMusic_Setup_1951.exe';
const WIN_TG = 'https://t.me/um_lsr_ch/24';
const MAC_880 =
  'https://web.archive.org/web/20230903/https://dldir1.qq.com/music/clntupate/mac/QQMusicMac_Mgr.dmg';
const MAC_TG = 'https://t.me/um_lsr_ch/21';
const MAC_DB =
  '~/Library/Containers/com.tencent.QQMusicMac/Data/Library/Application Support/QQMusicMac/mmkv/MMKVStreamEncryptId';
const ANDROID_DIR = '/data/data/com.tencent.qqmusic/databases';
const ANDROID_FILE = 'player_process_db';
const ADB_WINDOWS = `adb shell su -c "cp ${ANDROID_DIR}/${ANDROID_FILE} /sdcard/Download/"\nadb pull /sdcard/Download/${ANDROID_FILE}`;

const TABS: Array<{ id: Platform; label: string }> = [
  { id: 'windows', label: 'Windows' },
  { id: 'mac', label: 'macOS' },
  { id: 'android', label: 'Android' },
  { id: 'ios', label: 'iOS' },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--small btn--ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="link">
      {children}
    </a>
  );
}

export default function KeyGuide({ open, onClose, onAutoImport }: KeyGuideProps) {
  const [platform, setPlatform] = useState<Platform>('windows');

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--wide key-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-guide-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title" id="key-guide-title">
          密钥（ekey）使用说明
        </h2>
        <p className="modal__desc">
          每个资源（一首歌的某个音质）都有独立密钥，客户端在下载时把它写入本地密钥库。解密失败时，优先
          <strong>导入密钥</strong>；没有条件时，可以按下方说明<strong>降级客户端</strong>重新下载。
        </p>
        <p className="modal__desc">
          以下说明整理自{' '}
          <Link href={RELEASE_URL}>Unlock Music（um-react v0.5.0）</Link>
          。本工具不联网获取密钥、不读取账号凭证；只处理你自己选择的本地文件。
        </p>

        <div className="key-guide__tabs" role="tablist" aria-label="选择客户端平台">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={platform === tab.id}
              className={platform === tab.id ? 'key-guide__tab key-guide__tab--active' : 'key-guide__tab'}
              onClick={() => setPlatform(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {platform === 'windows' ? (
          <div className="key-guide__panel" role="tabpanel">
            <p>
              <strong>19.57 及以上</strong>：下载的文件需要导入密钥。um-react 的说明是「目前未公开密钥获取方式」，
              所以这个版本通常只能通过客户端本地密钥库或外部工具取得 ekey。
            </p>
            <p>
              <strong>19.51 及以下</strong>：密钥内嵌在文件里，<strong>无需导入</strong>，拖入即可解密。
            </p>
            <p>如需降级到 19.51：</p>
            <ul className="key-guide__list">
              <li>
                <Link href={WIN_1951}>Archive.org 缓存下载（较慢）</Link>
              </li>
              <li>
                <Link href={WIN_TG}>Telegram 下载（需要账号）</Link>
              </li>
            </ul>
            <p className="key-guide__hint">
              安装后可用同名空文件覆盖安装目录下的 <code>QQMusicUp.exe</code> 屏蔽自动更新；降级后要删除新版本
              已下载的文件，再用旧版本重新下载。
            </p>
            <p className="key-guide__hint">
              新版客户端的密钥库常见位置：安装目录下的 <code>QQMusicConfV3.dat</code>，以及
              <code>%APPDATA%\Tencent\QQMusic</code> 下的 <code>mmkv</code> 目录。把该目录选进「自动导入密钥」
              即可尝试扫描。
            </p>
          </div>
        ) : null}

        {platform === 'mac' ? (
          <div className="key-guide__panel" role="tabpanel">
            <p>macOS 客户端用 mmkv 数据库保存密钥。新版本会加密该数据库，目前需要降级到 <strong>8.8.0</strong>。</p>
            <ul className="key-guide__list">
              <li>
                <Link href={MAC_880}>Archive.org 缓存下载（较慢）</Link>
              </li>
              <li>
                <Link href={MAC_TG}>Telegram 下载（需要账号）</Link>
              </li>
            </ul>
            <p>密钥文件路径：</p>
            <div className="key-guide__path">
              <code>{MAC_DB}</code>
              <CopyButton text={MAC_DB} />
            </div>
            <p className="key-guide__hint">
              在本工具点「自动导入密钥」，选择该文件所在的 <code>mmkv</code> 文件夹即可；扫描只读本地文件。
            </p>
          </div>
        ) : null}

        {platform === 'android' ? (
          <div className="key-guide__panel" role="tabpanel">
            <p>
              安卓客户端把密钥放在私有目录，需要 <strong>root</strong> 权限（会失去保修）。文件路径：
            </p>
            <div className="key-guide__path">
              <code>
                {ANDROID_DIR}/{ANDROID_FILE}
              </code>
              <CopyButton text={`${ANDROID_DIR}/${ANDROID_FILE}`} />
            </div>
            <p>方法一：用支持 root 的文件管理器（Amaze、MT 管理器）把文件复制到「下载」目录。</p>
            <p>方法二：在电脑上用 ADB 拉取：</p>
            <div className="key-guide__path key-guide__path--block">
              <pre>{ADB_WINDOWS}</pre>
              <CopyButton text={ADB_WINDOWS} />
            </div>
            <p className="key-guide__hint">
              Linux / macOS 下的命令相同（把 <code>adb</code> 换成对应平台的二进制）。拿到文件后，在本工具点
              「自动导入密钥」，选择该文件所在的 <code>databases</code> 文件夹。
            </p>
          </div>
        ) : null}

        {platform === 'ios' ? (
          <div className="key-guide__panel" role="tabpanel">
            <p>iOS 没有简单的密钥导出方式：需要越狱，或用 PC/Mac 做完整备份后提取文件。</p>
            <p className="key-guide__hint">
              更实际的做法是换用 Windows / macOS 客户端重新下载同一首歌，再回到本工具解密。
            </p>
          </div>
        ) : null}

        <div className="key-guide__footer">
          <p className="key-guide__hint">
            拿到 ekey 后可直接粘贴到「需要密钥」弹窗；批量可用 <code>media_filename,ekey</code> 每行导入保险库。
          </p>
          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              关闭
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                onClose();
                onAutoImport();
              }}
            >
              打开自动导入密钥
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
