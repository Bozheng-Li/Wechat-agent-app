import { Button } from './button.jsx';
import { Glyph } from './glyph.jsx';
import { formatBytes, formatSavedBytes } from '../shared/updates.mjs';

// A single line above the workspace, so a new release never blocks the app.
export function UpdateBanner({ update }) {
  const { state, download, cancel, install, dismiss } = update;
  const percent = state.percent || 0;
  const saved = state.phase === 'ready' && state.differential?.used
    ? formatSavedBytes(state.differential.savedBytes)
    : '';
  return (
    <div className="wa-update-banner" data-testid="update-banner" data-phase={state.phase} role="status">
      <span className="wa-update-mark" aria-hidden="true"><Glyph name="download" /></span>
      <div className="wa-update-copy">
        <strong>
          {state.phase === 'ready' ? '更新已下载' : state.phase === 'installing' ? '正在安装更新' : '新版本 ' + state.version + ' 可用'}
        </strong>
        <p>
          {state.phase === 'available' && '当前 v' + state.currentVersion + ' · 安装包 ' + formatBytes(state.size) + ' · 下载完成后再点安装'}
          {state.phase === 'downloading' && '正在下载 ' + percent + '%（' + formatBytes(state.received) + ' / ' + formatBytes(state.total || state.size) + '）'}
          {state.phase === 'ready' && '已通过 SHA-512 校验，安装时应用会自动关闭并重新打开'}
          {state.phase === 'installing' && '安装程序已启动，本应用即将退出'}
        </p>
        {saved && <p className="wa-update-note" data-testid="update-delta-note">已用增量更新，节省 {saved}</p>}
        {state.phase === 'downloading' && (
          <div className="wa-update-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="更新下载进度">
            <span style={{ width: percent + '%' }} />
          </div>
        )}
      </div>
      <div className="wa-update-actions">
        {state.phase === 'available' && <Button icon="download" onClick={download}>下载更新</Button>}
        {state.phase === 'downloading' && <Button quiet onClick={cancel}>取消下载</Button>}
        {state.phase === 'ready' && <Button icon="refresh" onClick={install}>立即安装</Button>}
        {state.phase !== 'installing' && <Button quiet onClick={dismiss}>稍后</Button>}
      </div>
    </div>
  );
}
