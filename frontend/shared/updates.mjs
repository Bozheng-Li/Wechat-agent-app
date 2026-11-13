export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '大小未知';
  if (value < 1024 * 1024) return Math.max(1, Math.round(value / 1024)) + ' KB';
  return (value / (1024 * 1024)).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1) + ' MB';
}

// Savings are always a large fraction of a 200 MB+ installer, so one decimal
// keeps the note honest without turning it into a number nobody reads.
export function formatSavedBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024 * 1024) return Math.max(1, Math.round(value / 1024)) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

export function formatReleaseDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function formatCheckedAt(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export const updatePhaseLabels = {
  idle: '尚未检查',
  checking: '正在检查',
  current: '已是最新',
  available: '可更新',
  downloading: '正在下载',
  ready: '待安装',
  installing: '正在安装',
  error: '检查失败',
};

export function updatePhaseDetail(state) {
  switch (state.phase) {
    case 'checking':
      return '正在向发布服务查询最新版本…';
    case 'current':
      return `当前已是最新版本，上次检查 ${formatCheckedAt(state.checkedAt)}。`;
    case 'available':
      return `新版本 ${state.version} 已发布${state.releaseDate ? '（' + formatReleaseDate(state.releaseDate) + '）' : ''}，安装包 ${formatBytes(state.size)}。`;
    case 'downloading':
      return `正在下载更新包，已完成 ${state.percent || 0}%（${formatBytes(state.received)} / ${formatBytes(state.total || state.size)}）。`;
    case 'ready':
      return '更新包已下载并通过校验，安装时会关闭并重新打开应用。';
    case 'installing':
      return '正在启动安装程序，请按提示完成安装后重新打开应用。';
    case 'error':
      return state.message || '检查更新失败，请稍后再试。';
    default:
      return '检查新版本后，可在这里下载并安装更新。';
  }
}
