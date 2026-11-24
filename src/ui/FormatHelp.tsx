/** 支持的格式说明表（空队列时内嵌展示，也可从顶部按钮打开弹窗）。 */

const FORMAT_ROWS: Array<{ format: string; ext: string; key: string; note: string }> = [
  {
    format: 'QMC1',
    ext: '.qmcflac / .qmc0 / .qmc3 / .qmcogg',
    key: '内置静态密钥',
    note: '直接解密，无需 ekey',
  },
  {
    format: 'QMC2 · 旧尾部（PCv1 / QTag）',
    ext: '.mflac / .mgg',
    key: '文件内嵌',
    note: '自动读取并解密',
  },
  {
    format: 'QMC2 · MusicEx（PC ≥ 19.57）',
    ext: '.mflac / .mgg',
    key: '文件内不含密钥',
    note: '需要你补 ekey（可用保险库记住）',
  },
  {
    format: 'QMC2 · STag（Android ≥ 10.12）',
    ext: '.mflac / .mgg',
    key: '文件内不含密钥',
    note: '需要你补 ekey',
  },
  {
    format: '网易云 NCM',
    ext: '.ncm',
    key: '文件内嵌',
    note: '自动解密，兼容 3.x 无内嵌封面',
  },
  {
    format: '已是明文音频',
    ext: 'flac / mp3 / m4a / ogg / wav',
    key: '—',
    note: '原样输出，不重复处理',
  },
];

export function FormatTable() {
  return (
    <div className="table-wrap">
      <table className="format-table">
        <caption className="visually-hidden">UM Next 支持的加密格式与密钥来源</caption>
        <thead>
          <tr>
            <th scope="col">格式</th>
            <th scope="col">常见后缀</th>
            <th scope="col">密钥来源</th>
            <th scope="col">说明</th>
          </tr>
        </thead>
        <tbody>
          {FORMAT_ROWS.map((row) => (
            <tr key={row.format}>
              <th scope="row">{row.format}</th>
              <td className="mono">{row.ext}</td>
              <td>{row.key}</td>
              <td>{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface FormatHelpProps {
  open: boolean;
  onClose: () => void;
}

export default function FormatHelp({ open, onClose }: FormatHelpProps) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="format-help-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title" id="format-help-title">
          支持的格式
        </h2>
        <FormatTable />
        <p className="modal__desc">
          如果文件属于 MusicEx / STag，密钥不在文件里，需要你提供购买时获得的 ekey。本工具不提供
          密钥、不绕过任何账号或版权校验，只做「本地把已下载的文件转回可播放音频」。
        </p>
        <p className="modal__desc">
          OGG Vorbis（.ogg / .qmcogg / .mgg）可在顶栏勾选「OGG 转 MP3」：内置 libvorbis 解码 + LAME 编码，
          直接输出 320 kbps MP3（Worker 内完成，不联网）；转换失败会自动保留原始 OGG。
        </p>
        <div className="modal__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
