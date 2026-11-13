import { Button } from '../../components/button.jsx';
import { PageHead, Back } from '../../components/page-ui.jsx';
import { Glyph } from '../../components/glyph.jsx';
import { formatBytes, formatCheckedAt, formatReleaseDate, updatePhaseDetail, updatePhaseLabels } from '../../shared/updates.mjs';

export function UpdateSettings({ update, version, onBack, onOpenChangelog, onOpenReleasePage }) {
  const { state, check, download, cancel, install, openReleasePage } = update;
  const current = state.currentVersion || version || '—';
  const latest = ['available', 'downloading', 'ready', 'installing'].includes(state.phase);
  return (
    <>
      <Back label="返回设置" onClick={onBack} />
      <PageHead icon="download" title="版本与更新" description="检查新版本，下载更新包并由安装程序完成安装。" />
      <div className="wa-settings-stack wa-content-narrow wa-update-settings" data-testid="update-settings">
        <section className="wa-settings-block">
          <div className="wa-card-heading">
            <div>
              <h2>当前版本</h2>
              <p className="wa-muted">安装包来自本项目的 GitHub 发布页，下载后会先校验内容再安装。</p>
            </div>
            <span className="wa-update-badge" data-state={latest ? 'available' : state.phase} data-testid="update-state">
              {updatePhaseLabels[state.phase] || updatePhaseLabels.idle}
            </span>
          </div>
          <dl className="wa-update-facts">
            <div>
              <dt>已安装</dt>
              <dd className="wa-mono" data-testid="update-current">v{current}</dd>
            </div>
            {state.version && <div>
              <dt>{latest ? '最新版本' : '检查结果'}</dt>
              <dd className="wa-mono" data-testid="update-latest">v{state.version}</dd>
            </div>}
            {state.releaseDate && <div>
              <dt>发布时间</dt>
              <dd>{formatReleaseDate(state.releaseDate)}</dd>
            </div>}
            {!!state.size && <div>
              <dt>安装包</dt>
              <dd>{formatBytes(state.size)}</dd>
            </div>}
            {state.checkedAt && <div>
              <dt>最近检查</dt>
              <dd>{formatCheckedAt(state.checkedAt)}</dd>
            </div>}
          </dl>
          <p className="wa-help" data-testid="update-detail">{updatePhaseDetail(state)}</p>
          {state.phase === 'downloading' && (
            <div className="wa-update-progress is-wide" role="progressbar" aria-valuenow={state.percent || 0} aria-valuemin={0} aria-valuemax={100} aria-label="更新下载进度">
              <span style={{ width: (state.percent || 0) + '%' }} />
            </div>
          )}
          {state.message && state.phase !== 'error' && <p className="wa-help" role="alert">{state.message}</p>}
          <div className="wa-row wa-update-buttons">
            <Button icon="refresh" loading={state.phase === 'checking'} disabled={state.phase === 'downloading' || state.phase === 'installing'} onClick={() => check()}>
              {state.phase === 'checking' ? '正在检查…' : '检查更新'}
            </Button>
            {state.phase === 'available' && <Button primary icon="download" onClick={download}>下载更新</Button>}
            {state.phase === 'downloading' && <Button quiet onClick={cancel}>取消下载</Button>}
            {state.phase === 'ready' && <Button primary icon="refresh" onClick={install}>立即安装</Button>}
          </div>
        </section>

        <section className="wa-settings-block">
          <div className="wa-card-heading">
            <div>
              <h2>更新方式</h2>
              <p className="wa-muted">下载的是 Windows 安装包，覆盖安装后聊天记录、会话授权与模型配置都会保留。</p>
            </div>
          </div>
          <ul className="wa-update-notes">
            <li><Glyph name="check" className="wa-icon-small" />更新包只从项目发布页读取，并核对发布文件中的 SHA-512。</li>
            <li><Glyph name="check" className="wa-icon-small" />下载在本机主进程完成，页面无权访问网络，也不会接触安装包内容。</li>
            <li><Glyph name="check" className="wa-icon-small" />安装程序启动后应用会退出；数据保存在全局工作目录，不随程序覆盖而丢失。</li>
            <li><Glyph name="check" className="wa-icon-small" />离线或发布页不可达时只提示稍后重试，不影响正在运行的任务。</li>
          </ul>
          <div className="wa-row wa-update-links">
            <Button quiet icon="history" onClick={onOpenChangelog}>查看更新日志</Button>
            {state.pageURL && <Button quiet icon="arrow" onClick={openReleasePage}>打开发布页</Button>}
          </div>
        </section>
      </div>
    </>
  );
}
