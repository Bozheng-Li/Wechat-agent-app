import { useEffect, useState } from "react";
import { PageHead, Notice, Back } from "../../components/page-ui.jsx";
import { Field, FormActions } from "../../components/form-ui.jsx";
import { Button } from "../../components/button.jsx";

function sizeLabel(bytes = 0) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return Math.max(mb > 0 ? 1 : 0, Math.round(mb)) + ' MB';
}

/**
 * The data root owns config.yaml, the state index and every data tree. Pointing
 * both ends at one directory is what lets the desktop app and the DSH plugin
 * share accounts, records and memory; the switch is recorded and applied on the
 * next start so nothing is copied while a store is writing.
 */
function DataRootSettings({ rpc, blocked }) {
  const bridge = typeof window === 'undefined' ? undefined : window.wechatApp;
  const [info, setInfo] = useState(null);
  const [choice, setChoice] = useState('');
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [planned, setPlanned] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [otherAccount, setOtherAccount] = useState(false);

  const load = async () => {
    setWorking('load');
    try {
      const value = await rpc('storage.data-root', {});
      setInfo(value);
      setChoice((current) => current || value.plugin?.root || '');
      setError('');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setWorking('');
    }
  };
  useEffect(() => { void load(); }, []);

  const pick = async () => {
    const value = await bridge?.pickDirectory?.(choice || info?.current?.root || '');
    if (value) { setChoice(value); setConfirming(false); setOtherAccount(false); setDone(''); }
  };
  const open = (target) => { if (target) void bridge?.openPath?.(target).catch(() => {}); };
  const switchTo = async (mode) => {
    const target = choice.trim();
    if (!target) return;
    if (mode === 'copy' && !confirming) { setConfirming(true); setDone(''); return; }
    setWorking(mode); setError(''); setDone('');
    try {
      const value = await rpc('storage.data-root.switch', { target, mode, confirm: otherAccount });
      setPlanned(value);
      setConfirming(false);
      setOtherAccount(false);
      setDone(mode === 'copy'
        ? '已排定：下次启动时先把当前数据复制到新目录，再切换过去。'
        : '已排定：下次启动时改用这个数据目录。');
    } catch (failure) {
      setOtherAccount(failure.code === 'DATA_ROOT_OTHER_ACCOUNT');
      setError(failure.message);
    } finally {
      setWorking('');
    }
  };
  const restart = () => { void bridge?.relaunch?.().catch(() => {}); };

  if (!info) {
    return (
      <section className="wa-settings-block" data-testid="data-root-settings">
        <div className="wa-card-heading">
          <div>
            <h2>数据目录</h2>
            <p className="wa-muted">正在读取当前数据目录…</p>
          </div>
        </div>
        {error && <div className="wa-alert is-error" role="alert">{error}</div>}
      </section>
    );
  }
  const current = info.current || {};
  const plugin = info.plugin;
  const sameAsPlugin = Boolean(plugin && (info.sameAsPlugin || plugin.root === current.root));
  const accountsText = (list) => (list && list.length ? list.join('、') : '还没有微信账号记录');
  const sharedAccounts = (plugin?.accounts || []).filter((id) => (current.accounts || []).includes(id));
  return (
    <section className="wa-settings-block wa-dataroot" data-testid="data-root-settings">
      <div className="wa-card-heading">
        <div>
          <h2>数据目录</h2>
          <p className="wa-muted">
            账号、模型配置、会话记录、记忆和朋友圈数据都保存在这个根目录里。桌面版和 DSH 插件指向同一个目录时，两端读写的就是同一份数据；换电脑时复制这个目录即可继续使用。
          </p>
        </div>
      </div>
      <div className="wa-applied-path">
        <span className="wa-help">当前使用</span>
        <span className="wa-path-value" data-testid="data-root-current">{current.root}</span>
        <span className="wa-help">{sizeLabel(current.bytes)}</span>
        <Button quiet onClick={() => open(current.root)}>打开文件夹</Button>
      </div>
      <p className="wa-help" data-testid="data-root-accounts">当前目录里的微信账号：{accountsText(current.accounts)}</p>
      {info.lastSwitchError && <div className="wa-alert is-error" role="alert">{info.lastSwitchError}</div>}
      {!current.exists && (
        <div className="wa-alert is-error" role="alert">
          当前数据目录还不存在，应用会在首次保存时创建。如果这是从别的电脑复制过来的配置，请把“要使用的数据目录”改成原数据所在的位置。
        </div>
      )}
      {plugin && (
        <div className="wa-dataroot-detected" data-testid="data-root-plugin">
          <div>
            <p className="wa-dataroot-title">
              {sameAsPlugin ? '与 DSH 插件共用同一个数据目录' : '检测到 DSH 插件的微信数据目录'}
            </p>
            <p className="wa-path-value">{plugin.root}</p>
            <p className="wa-help" data-testid="data-root-plugin-accounts">插件目录里的微信账号：{accountsText(plugin.accounts)}</p>
            <p className="wa-help">
              {sameAsPlugin
                ? '两端已指向同一目录，切换前请确保只有一个端在运行。'
                : plugin.locked
                  ? '插件正在使用这个目录，请先在 DSH 里停止插件再切换。'
                  : !plugin.exists
                    ? '该目录当前不存在，改用后会按新目录初始化。'
                    : sharedAccounts.length
                      ? '与当前账号相同，可以直接改用，两端共用这个账号的记录与记忆。'
                      : (current.accounts || []).length
                        ? '账号与当前不同：通常应保持两个独立目录；确实要接管这份数据时再确认一次。'
                        : `可以直接改用这个目录，继续使用其中的账号与记录（${sizeLabel(plugin.bytes)}）。`}
            </p>
          </div>
          {!sameAsPlugin && (
            <Button quiet disabled={blocked || plugin.locked} onClick={() => { setChoice(plugin.root); setConfirming(false); setOtherAccount(false); setDone(''); }}>
              填入这个目录
            </Button>
          )}
        </div>
      )}
      <Field
        label="要使用的数据目录"
        id="wa-data-root"
        help="填写本机绝对路径，或在磁盘中选择。切换只在重启后生效，失败时会继续使用原来的目录。"
      >
        <div className="wa-path-field">
          <input
            className="wa-input wa-mono"
            id="wa-data-root"
            value={choice}
            disabled={blocked}
            placeholder="例如：D:\微信机器人"
            onChange={(event) => { setChoice(event.target.value); setConfirming(false); setOtherAccount(false); setDone(''); }}
          />
          <Button quiet icon="folder" disabled={blocked} onClick={pick}>浏览…</Button>
        </div>
      </Field>
      {confirming && (
        <div className="wa-alert is-error" role="alert">
          <div className="wa-row">
            复制会把当前数据<strong>合并</strong>到 {choice.trim()}，目标目录里已有的同名文件会被覆盖。确认继续？
          </div>
        </div>
      )}
      {otherAccount && (
        <div className="wa-alert is-error" role="alert">
          <div className="wa-row">
            目标目录属于另一个微信账号。再点一次「仍要使用这个目录」就会切换；当前目录的数据不会被删除，之后还可以切回来。
          </div>
        </div>
      )}
      <div className="wa-dataroot-actions">
        <Button
          primary
          disabled={blocked || !choice.trim() || Boolean(working)}
          onClick={() => switchTo('use')}
        >
          {working === 'use' ? '正在排定…' : otherAccount ? '仍要使用这个目录' : '直接使用这个目录'}
        </Button>
        <Button quiet disabled={blocked || !choice.trim() || Boolean(working)} onClick={() => switchTo('copy')}>
          {working === 'copy' ? '正在排定…' : confirming ? '确认复制并切换' : '复制当前数据过去'}
        </Button>
        {planned && <Button onClick={restart}>立即重启</Button>}
      </div>
      {done && <div className="wa-alert is-success" role="status">{done}</div>}
      {error && <div className="wa-alert is-error" role="alert">{error}</div>}
      <p className="wa-help">
        同一个数据目录同一时间只能有一个端在运行，另一端会提示“正被另一个实例使用”。模型服务列表、搜索与生图密钥保存在本机的加密存储里：换设备、或在另一端首次打开同一目录时，可能需要重新添加模型服务并填写一次密钥。
      </p>
    </section>
  );
}

export function StorageSettings({
  status,
  draft,
  blocked,
  busy,
  dirty,
  notice,
  onChange,
  onSave,
  onReset,
  onBack,
  backLabel,
  rpc,
}) {
  const storage = status.storage || {};
  const bridge = typeof window === 'undefined' ? undefined : window.wechatApp;
  const pickDirectory = async () => {
    const value = await bridge?.pickDirectory?.(draft.basePath?.trim() || storage.basePath || '');
    if (value) onChange({ ...draft, basePath: value });
  };
  const openApplied = () => {
    const target = storage.basePath || storage.workspacePath;
    if (target) void bridge?.openPath?.(target).catch(() => {});
  };
  const directories = [
    ['workspacePath', '工作空间总目录'],
    ['agentWorkspacePath', '微信 Agent 工作区'],
    ['recordsPath', '会话记录'],
    ['memoryPath', '记忆资料'],
    ['assetsPath', '表情与图片素材'],
    ['tasksPath', '定时任务'],
    ['loginPath', '微信登录资料'],
    ['cachePath', '缓存'],
  ];
  return (
    <>
      <Back label={backLabel} onClick={onBack} />
      <PageHead icon="folder" title="数据目录" description="只需设置一个目录，应用会自动管理各类数据的保存位置。" />
      <Notice notice={notice} area="storage" />
      <div className="wa-settings-stack wa-content-narrow wa-storage-settings">
        <DataRootSettings rpc={rpc} blocked={blocked} />
        <form
          className="wa-settings-block"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <div className="wa-card-heading">
            <div>
              <h2>应用数据的统一位置</h2>
              <p className="wa-muted">选择一个本机可写入的目录，也可以直接填写绝对路径。</p>
            </div>
          </div>
          <Field
            label="数据目录"
            id="wa-base-path"
            help="记录、记忆、素材、定时任务、登录资料和缓存都在此目录下自动管理。"
          >
            <div className="wa-path-field">
              <input
                className="wa-input wa-mono"
                id="wa-base-path"
                value={draft.basePath}
                disabled={blocked}
                placeholder="例如：D:\WechatAgent"
                onChange={(event) => onChange({ ...draft, basePath: event.target.value })}
              />
              <Button quiet icon="folder" disabled={blocked} onClick={pickDirectory}>
                浏览…
              </Button>
            </div>
          </Field>
          {storage.basePath && (
            <div className="wa-applied-path">
              <span className="wa-help">当前使用</span>
              <span className="wa-path-value">{storage.basePath}</span>
              <Button quiet onClick={openApplied}>打开文件夹</Button>
            </div>
          )}
          <div className="wa-note-box">
            <p>保存后等待当前任务收尾，再迁移到新目录；旧目录和失败时的输入草稿保留。</p>
          </div>
          <details className="wa-subsection" data-testid="storage-derived-paths">
            <summary>查看自动管理的目录</summary>
            <p className="wa-help">以下为当前已应用的位置，由数据目录自动派生。</p>
            <dl className="wa-storage-path-list">
            {directories.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd className="wa-path-value" data-storage-path={key}>
                  {storage[key] || '正在读取保存位置'}
                </dd>
              </div>
            ))}
            </dl>
          </details>
          <FormActions
            dirty={dirty}
            busy={busy === 'storage.save'}
            disabled={blocked}
            invalid={!draft.basePath.trim()}
            onReset={onReset}
            label="保存目录并应用"
          />
        </form>
        <details className="wa-settings-block wa-data-details">
          <summary>数据来源与保存方式</summary>
          <div className="wa-note-box">
            <p>
              <strong>应用记录不等同于微信完整聊天历史。</strong>
            </p>
            <p>
              这里保存应用同步后观察到的消息与处理结果，最近 {storage.observedMessageLimit || 1000}{' '}
              条观察消息可用于上下文。微信客户端已有的全部历史不会自动导入。
            </p>
          </div>
          <div className="wa-subsection">
            <h3>本地任务与执行记录</h3>
            <p className="wa-help">内部微信会话归入工作空间总目录下的“微信agent”；生成图片另存于“微信agent/generated-images”。模型和工具执行记录保存在本应用的任务执行轨迹中。</p>
            <div className="wa-path-value">{storage.workspacePath || '随数据目录保存'}</div>
          </div>
        </details>
      </div>
    </>
  );
}
