import { useEffect, useMemo, useState } from 'react';
import { call } from '../../shared/rpc.mjs';
import { Field } from '../../components/form-ui.jsx';
import { Button } from '../../components/button.jsx';
import { Glyph } from '../../components/glyph.jsx';

// Presets only carry what stays stable: an identifier, a label and the endpoint the
// vendor documents. Model names change too often to hardcode, so the editor asks the
// endpoint for its own list instead.
const presets = [
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1' },
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1' },
  { id: 'moonshot', name: 'Kimi（月之暗面）', baseURL: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'qwen', name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'siliconflow', name: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1' },
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' },
];

const blankModel = () => ({ id: '', name: '', vision: false, efforts: '' });
const blankDraft = () => ({ id: '', name: '', baseURL: '', stream: true, requiresKey: true, models: [blankModel()] });

const providerDraft = provider => ({
  id: provider.id,
  name: provider.name,
  baseURL: provider.baseURL,
  stream: provider.stream !== false,
  requiresKey: provider.requiresKey !== false,
  models: provider.models.length
    ? provider.models.map(model => ({
        id: model.id,
        name: model.name && model.name !== model.id ? model.name : '',
        vision: model.vision === true,
        efforts: (model.reasoningEfforts ?? []).join(','),
      }))
    : [blankModel()],
});

const modelPayload = models =>
  models
    .map(model => ({
      id: model.id.trim(),
      name: (model.name || '').trim() || model.id.trim(),
      vision: model.vision === true,
      reasoningEfforts: (model.efforts || '')
        .split(/[\s,，、]+/)
        .map(value => value.trim())
        .filter(Boolean),
    }))
    .filter(model => model.id);

function draftError(draft, creating) {
  if (creating && !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(draft.id)) return '服务编号需以小写字母开头，之后可用小写字母、数字、下划线和短横线。';
  if (!draft.name.trim()) return '请填写显示名称。';
  if (!draft.baseURL.trim()) return '请填写 API 地址。';
  const models = modelPayload(draft.models), ids = models.map(model => model.id);
  if (!models.length) return '请至少添加一个模型。';
  if (ids.some(id => /\s/.test(id))) return '模型 ID 中不能包含空格。';
  if (new Set(ids).size !== ids.length) return '模型 ID 不能重复。';
  return '';
}

function SecretField({ id, value, onChange, configured, disabled }) {
  const [reveal, setReveal] = useState(false);
  useEffect(() => { if (!value) setReveal(false); }, [value]);
  return (
    <div className="wa-secret-field">
      <input
        className="wa-input"
        id={id}
        type={reveal ? 'text' : 'password'}
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        disabled={disabled}
        placeholder={configured ? '已保存，留空则保持不变' : '输入 API 密钥'}
        onChange={event => onChange(event.target.value)}
      />
      <button
        type="button"
        className="wa-secret-reveal"
        aria-label={reveal ? '隐藏密钥' : '显示密钥'}
        aria-pressed={reveal}
        disabled={disabled || !value}
        onClick={() => setReveal(!reveal)}
      >
        <Glyph name={reveal ? 'eyeOff' : 'eye'} />
      </button>
    </div>
  );
}

function Dialog({ label, onClose, children }) {
  useEffect(() => {
    const dismiss = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [onClose]);
  return (
    <div className="wa-dialog-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="wa-dialog" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

function ModelRow({ index, model, disabled, onChange, onRemove }) {
  const label = model.id || `第 ${index + 1} 个模型`;
  return (
    <div className="wa-model-row">
      <div className="wa-model-row-main">
        <Field label="模型 ID" id={`wa-provider-model-${index}`}>
          <input
            className="wa-input wa-mono"
            id={`wa-provider-model-${index}`}
            data-testid={`model-id-${index}`}
            value={model.id}
            disabled={disabled}
            spellCheck={false}
            placeholder="例如 deepseek-chat"
            onChange={event => onChange({ ...model, id: event.target.value })}
          />
        </Field>
        <Field label="显示名称" id={`wa-provider-model-name-${index}`}>
          <input
            className="wa-input"
            id={`wa-provider-model-name-${index}`}
            value={model.name}
            disabled={disabled}
            placeholder="留空时使用模型 ID"
            onChange={event => onChange({ ...model, name: event.target.value })}
          />
        </Field>
        <Button quiet icon="trash" className="wa-model-row-remove" aria-label={'删除模型 ' + label}
          title="删除模型" disabled={disabled} onClick={onRemove} />
      </div>
      <div className="wa-model-row-options">
        <span className="wa-model-row-label">输入类型</span>
        <label className="wa-check-row is-static">
          <input type="checkbox" checked readOnly disabled />文本
        </label>
        <label className="wa-check-row">
          <input type="checkbox" checked={model.vision} disabled={disabled}
            onChange={event => onChange({ ...model, vision: event.target.checked })} />图片
        </label>
        <label className="wa-model-row-efforts">
          <span>推理强度</span>
          <input
            className="wa-input"
            aria-label={label + ' 推理强度'}
            value={model.efforts}
            disabled={disabled}
            spellCheck={false}
            placeholder="可选，如 low,medium,high"
            onChange={event => onChange({ ...model, efforts: event.target.value })}
          />
        </label>
      </div>
    </div>
  );
}

export function ProviderSettings({ connection, catalog }) {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [addMode, setAddMode] = useState('catalog');
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(blankDraft);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(null);
  const [discovery, setDiscovery] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    call(connection, 'providers.list', {}, controller.signal)
      .then(value => setProviders(value.providers))
      .catch(failure => { if (!controller.signal.aborted) setLoadError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connection]);

  const taken = useMemo(() => new Set(providers.map(provider => provider.id)), [providers]);
  const availablePresets = presets.filter(preset => !taken.has(preset.id));
  const editing = editingId ? providers.find(provider => provider.id === editingId) : null;
  const open = creating || !!editing;
  const setModels = models => setDraft(current => ({ ...current, models }));

  const openEditor = provider => {
    setCreating(false);
    setEditingId(provider.id);
    setDraft(providerDraft(provider));
    setExpanded(provider.models.length === 0);
    setApiKey('');
    setError('');
    setNotice('');
    setDiscovery(null);
  };

  const openCreator = () => {
    setCreating(true);
    setEditingId(null);
    setDraft(blankDraft());
    setAddMode(availablePresets.length ? 'catalog' : 'custom');
    setExpanded(true);
    setApiKey('');
    setError('');
    setNotice('');
    setDiscovery(null);
  };

  const closeEditor = () => {
    setCreating(false);
    setEditingId(null);
    setDraft(blankDraft());
    setApiKey('');
    setError('');
    setExpanded(false);
    setDiscovery(null);
  };

  const applyPreset = id => {
    const preset = presets.find(value => value.id === id);
    if (!preset) return;
    setDraft({ ...blankDraft(), id: preset.id, name: preset.name, baseURL: preset.baseURL, models: [blankModel()] });
    setAddMode('custom');
  };

  const save = async event => {
    event?.preventDefault();
    const invalid = draftError(draft, creating);
    if (invalid) { setError(invalid); return; }
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const value = await call(
        connection,
        'providers.save',
        {
          provider: { ...draft, name: draft.name.trim(), baseURL: draft.baseURL.trim(), models: modelPayload(draft.models) },
          ...(apiKey ? { apiKey } : {}),
        },
        AbortSignal.timeout(20000)
      );
      setProviders(value.providers);
      setNotice('已保存 ' + draft.name.trim() + '。');
      closeEditor();
      await catalog.refresh().catch(() => {});
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  };

  const test = async provider => {
    const model = provider.models[0];
    if (!model) { setError('请先为该服务添加模型，再测试连接。'); return; }
    setBusy('test');
    setError('');
    setNotice('');
    try {
      const result = await call(connection, 'providers.test', { provider: provider.id, model: model.id }, AbortSignal.timeout(60000));
      setNotice(result.message);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    if (!confirming) return;
    setBusy('delete');
    setError('');
    try {
      const value = await call(connection, 'providers.delete', { provider: confirming.id }, AbortSignal.timeout(30000));
      setProviders(value.providers);
      setNotice('已删除 ' + confirming.name + '。');
      if (editingId === confirming.id) closeEditor();
      setConfirming(null);
      await catalog.refresh().catch(() => {});
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  };

  const discover = async () => {
    if (!draft.baseURL.trim()) { setError('请先填写 API 地址，再获取。'); return; }
    setBusy('discover');
    setError('');
    try {
      const value = await call(
        connection,
        'providers.discover',
        { provider: creating ? undefined : draft.id, baseURL: draft.baseURL.trim(), ...(apiKey ? { apiKey } : {}) },
        AbortSignal.timeout(45000)
      );
      if (!value.models.length) { setError('该服务没有列出任何模型，请手动添加。'); return; }
      setDiscovery({ items: value.models, selected: new Set(), query: '' });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  };

  const addSelectedModels = () => {
    if (!discovery) return;
    const existing = new Set(draft.models.map(model => model.id.trim()).filter(Boolean));
    const added = discovery.items
      .filter(item => discovery.selected.has(item.id) && !existing.has(item.id))
      .map(item => ({ id: item.id, name: item.name && item.name !== item.id ? item.name : '', vision: false, efforts: '' }));
    const kept = draft.models.filter(model => model.id.trim());
    setModels(kept.length + added.length ? [...kept, ...added] : [blankModel()]);
    setDiscovery(null);
  };

  const candidates = discovery
    ? discovery.items.filter(item => {
        const query = discovery.query.trim().toLowerCase();
        return !query || item.id.toLowerCase().includes(query) || (item.name || '').toLowerCase().includes(query);
      })
    : [];

  const editor = (
    <form className="wa-service-editor" onSubmit={save} data-testid={creating ? 'provider-create' : 'provider-edit'}>
      <div className="wa-service-editor-head">
        <div>
          <h3>{creating ? '添加模型提供商' : draft.name || '未命名服务'}</h3>
          <p className="wa-muted">{creating ? '选择常用服务，或自行填写接口信息。' : draft.id}</p>
        </div>
        <Button quiet icon="close" aria-label="关闭编辑" onClick={closeEditor} />
      </div>
      {creating && (
        <>
          <div className="wa-segmented" role="tablist" aria-label="添加方式">
            <button type="button" role="tab" aria-selected={addMode === 'catalog'} disabled={!availablePresets.length}
              onClick={() => setAddMode('catalog')}>第三方模型提供商</button>
            <button type="button" role="tab" aria-selected={addMode === 'custom'}
              onClick={() => setAddMode('custom')}>自定义模型 API</button>
          </div>
          <p className="wa-help">
            {addMode === 'catalog'
              ? availablePresets.length
                ? '从常用服务中选择，填入其 API 密钥即可使用。'
                : '常用服务都已添加，可以改用自定义模型 API。'
              : '连接中转站、自部署服务或其他兼容 OpenAI 协议的接口，需填写 API 地址和模型。'}
          </p>
          {addMode === 'catalog' && (
            <Field label="提供商" id="wa-provider-preset">
              <select className="wa-select" id="wa-provider-preset" value="" onChange={event => applyPreset(event.target.value)}>
                <option value="">选择提供商</option>
                {availablePresets.map(preset => (
                  <option key={preset.id} value={preset.id}>{preset.name} · {preset.baseURL}</option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}
      {(!creating || addMode === 'custom') && (
        <>
          {creating ? (
            <div className="wa-form-grid">
              <Field label="服务编号" id="wa-provider-id" help="以小写字母开头，保存后用于识别此服务。">
                <input className="wa-input wa-mono" id="wa-provider-id" value={draft.id} disabled={busy === 'save'}
                  pattern="[a-z0-9](?:[a-z0-9_]|-){0,47}" placeholder="deepseek" required
                  onChange={event => setDraft({ ...draft, id: event.target.value.toLowerCase() })} />
              </Field>
              <Field label="显示名称" id="wa-provider-name">
                <input className="wa-input" id="wa-provider-name" value={draft.name} disabled={busy === 'save'}
                  maxLength={100} placeholder="例如 我的模型服务" required
                  onChange={event => setDraft({ ...draft, name: event.target.value })} />
              </Field>
            </div>
          ) : (
            <Field label="显示名称" id="wa-provider-name" help="用于在模型服务列表与模型选择器中识别此服务。">
              <input className="wa-input" id="wa-provider-name" value={draft.name} disabled={busy === 'save'}
                maxLength={100} placeholder="例如 我的模型服务" required
                onChange={event => setDraft({ ...draft, name: event.target.value })} />
            </Field>
          )}
          <Field label="API 密钥" id="wa-provider-key"
            help={editing?.credentialConfigured
              ? '已保存密钥；留空则保持当前密钥。更换 API 地址后需要重新保存密钥。'
              : '留空可先保存配置，稍后补密钥；未配置密钥的服务无法用于回复。'}>
            <SecretField id="wa-provider-key" value={apiKey} onChange={setApiKey} disabled={busy === 'save'}
              configured={editing?.credentialConfigured} />
          </Field>
          <details className="wa-subsection wa-service-advanced" open={expanded}
            onToggle={event => setExpanded(event.currentTarget.open)}>
            <summary>自定义设置{draft.models.filter(model => model.id.trim()).length ? ` · ${draft.models.filter(model => model.id.trim()).length} 个模型` : ''}</summary>
            <Field label="API 地址" id="wa-provider-url"
              help="兼容 OpenAI Chat Completions 的根地址；本机服务可以使用 http://localhost。">
              <input className="wa-input wa-mono" id="wa-provider-url" type="url" value={draft.baseURL}
                disabled={busy === 'save'} placeholder="https://api.deepseek.com/v1" required
                onChange={event => setDraft({ ...draft, baseURL: event.target.value })} />
            </Field>
            <div className="wa-model-catalog-head">
              <div>
                <h3>模型目录</h3>
                <p className="wa-muted">这里列出的模型会出现在回复模型选择器中。</p>
              </div>
              <div className="wa-row">
                <Button quiet icon="refresh" disabled={!!busy} onClick={discover}>
                  {busy === 'discover' ? '正在询问服务…' : '获取可用模型'}
                </Button>
                <Button quiet icon="plus" disabled={!!busy}
                  onClick={() => setModels([...draft.models, blankModel()])}>添加模型</Button>
              </div>
            </div>
            {!draft.models.length && <p className="wa-help">还没有模型。点击「获取可用模型」从服务读取，或手动添加。</p>}
            <div className="wa-model-rows">
              {draft.models.map((model, index) => (
                <ModelRow key={index} index={index} model={model} disabled={busy === 'save'}
                  onChange={next => setModels(draft.models.map((value, at) => (at === index ? next : value)))}
                  onRemove={() => setModels(draft.models.filter((_, at) => at !== index))} />
              ))}
            </div>
            <div className="wa-service-toggles">
              <label className="wa-check-row">
                <input type="checkbox" checked={draft.stream} disabled={busy === 'save'}
                  onChange={event => setDraft({ ...draft, stream: event.target.checked })} />使用流式接口
              </label>
              <label className="wa-check-row">
                <input type="checkbox" checked={!draft.requiresKey} disabled={busy === 'save'}
                  onChange={event => setDraft({ ...draft, requiresKey: !event.target.checked })} />服务无需 API 密钥
              </label>
            </div>
          </details>
        </>
      )}
      <div className="wa-form-actions">
        <span className={error ? 'wa-alert is-error' : 'wa-help'} role={error ? 'alert' : undefined}>
          {error || '密钥由 Windows 加密保存在本机，保存后对下一个任务生效。'}
        </span>
        <div className="wa-row">
          <Button quiet onClick={closeEditor} disabled={busy === 'save'}>取消</Button>
          <Button type="submit" primary loading={busy === 'save'} disabled={busy === 'save' || (creating && addMode === 'catalog')}>
            {busy === 'save' ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </form>
  );

  return (
    <section className="wa-settings-block wa-model-services" data-testid="provider-settings">
      <div className="wa-card-heading">
        <div>
          <h2>模型服务</h2>
          <p className="wa-muted">填入各服务的 API 密钥即可使用其模型。密钥由 Windows 加密保存在本机。</p>
        </div>
      </div>
      {loadError && <p className="wa-alert is-error" role="alert">{loadError}</p>}
      {loading && !providers.length && <p className="wa-help" role="status">正在读取模型服务…</p>}
      {!loading && !providers.length && !creating && (
        <p className="wa-help">还没有模型服务。添加一个服务并填入 API 密钥后，即可选择回复模型。</p>
      )}
      {(providers.length > 0 || creating) && (
        <ul className="wa-service-list">
          {providers.map(provider => {
            const active = editingId === provider.id;
            return (
              <li className="wa-service" key={provider.id} data-active={active ? 'true' : undefined}>
                <div className="wa-service-row">
                  <span className="wa-service-dot" data-state={provider.credentialConfigured ? 'ok' : 'missing'} aria-hidden="true" />
                  <div className="wa-service-id">
                    <h3>{provider.name}</h3>
                    <p className="wa-muted">{provider.id} · {provider.models.length} 个模型 · {provider.baseURL}</p>
                    <p className="wa-service-state" data-state={provider.credentialConfigured ? 'ok' : 'missing'}>
                      {provider.credentialConfigured ? 'API 密钥已配置' : 'API 密钥缺失'}
                    </p>
                  </div>
                  <div className="wa-service-actions">
                    <Button quiet onClick={() => (active ? closeEditor() : openEditor(provider))}>{active ? '收起' : '编辑'}</Button>
                    <Button quiet disabled={!!busy} onClick={() => test(provider)}>测试连接</Button>
                    <Button quiet danger disabled={!!busy} onClick={() => setConfirming(provider)}>删除</Button>
                  </div>
                </div>
                {active && editor}
              </li>
            );
          })}
          {creating && <li className="wa-service is-new" data-active="true">{editor}</li>}
        </ul>
      )}
      {!open && (
        <div className="wa-row wa-service-add">
          <Button icon="plus" onClick={openCreator}>添加模型提供商</Button>
        </div>
      )}
      {notice && <p className="wa-help" role="status">{notice}</p>}
      {error && !open && <p className="wa-alert is-error" role="alert">{error}</p>}
      {confirming && (
        <Dialog label={'删除 ' + confirming.name} onClose={() => setConfirming(null)}>
          <div className="wa-dialog-head">
            <h3>删除 {confirming.name}？</h3>
            <p className="wa-muted">删除 {confirming.name} 会移除其配置和存储的 API 密钥，使用它的会话将无法再调用该模型。</p>
          </div>
          <div className="wa-dialog-actions">
            <Button quiet onClick={() => setConfirming(null)} disabled={busy === 'delete'}>取消</Button>
            <Button danger loading={busy === 'delete'} onClick={remove}>
              {busy === 'delete' ? '正在删除…' : '删除 ' + confirming.name}
            </Button>
          </div>
        </Dialog>
      )}
      {discovery && (
        <Dialog label="选择要添加的模型" onClose={() => setDiscovery(null)}>
          <div className="wa-dialog-head">
            <h3>选择要添加的模型</h3>
            <p className="wa-muted">以下是模型提供商的可用模型，勾选要添加的模型。</p>
          </div>
          <div className="wa-discover-tools">
            <input className="wa-input" type="search" aria-label="搜索模型" placeholder="搜索模型"
              value={discovery.query} onChange={event => setDiscovery({ ...discovery, query: event.target.value })} />
            <Button quiet onClick={() => setDiscovery({ ...discovery, selected: new Set(candidates.map(item => item.id)) })}>全选</Button>
            <Button quiet onClick={() => setDiscovery({ ...discovery, selected: new Set() })}>取消全选</Button>
          </div>
          <ul className="wa-discover-list">
            {candidates.map(item => (
              <li key={item.id}>
                <label className="wa-discover-item">
                  <input type="checkbox" checked={discovery.selected.has(item.id)}
                    onChange={event => {
                      const selected = new Set(discovery.selected);
                      if (event.target.checked) selected.add(item.id); else selected.delete(item.id);
                      setDiscovery({ ...discovery, selected });
                    }} />
                  <span className="wa-mono">{item.id}</span>
                  {item.name && item.name !== item.id && <span className="wa-muted">{item.name}</span>}
                </label>
              </li>
            ))}
            {!candidates.length && <li className="wa-help">没有匹配的模型。</li>}
          </ul>
          <div className="wa-dialog-actions">
            <span className="wa-help">已选择 {discovery.selected.size} 个</span>
            <div className="wa-row">
              <Button quiet onClick={() => setDiscovery(null)}>取消</Button>
              <Button primary disabled={!discovery.selected.size} onClick={addSelectedModels}>添加所选</Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
