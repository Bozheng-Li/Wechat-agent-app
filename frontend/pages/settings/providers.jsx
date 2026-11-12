import { useEffect, useState } from 'react';
import { call } from '../../shared/rpc.mjs';
import { Field } from '../../components/form-ui.jsx';
import { Button } from '../../components/button.jsx';

const empty = () => ({ id: '', name: '', baseURL: '', models: [], stream: true, requiresKey: true });
export function ProviderSettings({ connection, catalog }) {
  const [providers, setProviders] = useState([]), [draft, setDraft] = useState(empty), [modelText, setModelText] = useState('');
  const [apiKey, setApiKey] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    call(connection, 'providers.list', {}, controller.signal).then(value => setProviders(value.providers)).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [connection]);
  const choose = id => {
    const provider = providers.find(value => value.id === id) ?? empty(); setDraft(provider);
    setModelText(provider.models.map(model => model.id).join('\n')); setApiKey(''); setNotice(''); setError('');
  };
  const ids = [...new Set(modelText.split(/[\n,，]/).map(value => value.trim()).filter(Boolean))];
  const models = ids.map(id => draft.models.find(model => model.id === id) ?? { id, vision: false, reasoningEfforts: [] });
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const savedModels = models.map(model => ({ ...model, reasoningEfforts: (model.reasoningEfforts ?? []).map(value => value.trim()).filter(Boolean) }));
      const value = await call(connection, 'providers.save', { provider: { ...draft, models: savedModels }, ...(apiKey ? { apiKey } : {}) }, AbortSignal.timeout(15000));
      setProviders(value.providers); setDraft(value.providers.find(value => value.id === draft.id)); setApiKey('');
      await catalog.refresh(); setNotice('模型服务已保存，下面可选择回复模型。');
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setNotice(''); setError('');
    try {
      const saved = providers.find(value => value.id === draft.id);
      const result = await call(connection, 'providers.test', { provider: saved.id, model: saved.models[0].id }, AbortSignal.timeout(50000)); setNotice(result.message);
    }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return <section className="wa-settings-block" data-testid="provider-settings">
    <div className="wa-card-heading"><div><h2>模型 API 服务</h2><p className="wa-muted">配置兼容 Chat Completions 的服务。API Key 由 Windows 加密保存在本机。</p></div></div>
    <form onSubmit={save} className="wa-stack">
      <Field label="编辑服务" id="wa-provider-select"><select id="wa-provider-select" className="wa-select" value={providers.some(value => value.id === draft.id) ? draft.id : ''} onChange={event => choose(event.target.value)} disabled={busy}>
        <option value="">添加服务</option>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
      </select></Field>
      <div className="wa-form-grid">
        <Field label="服务编号" id="wa-provider-id" help="例如 deepseek；保存后用于识别此服务。"><input id="wa-provider-id" className="wa-input" required pattern="[a-z0-9](?:[a-z0-9_]|-){0,47}" value={draft.id} disabled={busy || providers.some(value => value.id === draft.id)} onChange={event => setDraft({ ...draft, id: event.target.value })} placeholder="deepseek" /></Field>
        <Field label="显示名称" id="wa-provider-name"><input id="wa-provider-name" className="wa-input" required maxLength={100} value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="我的模型服务" /></Field>
      </div>
      <Field label="API 根地址" id="wa-provider-url" help="填写服务商提供的地址；本机服务支持 http://localhost。"><input id="wa-provider-url" className="wa-input" type="url" required value={draft.baseURL} disabled={busy} onChange={event => setDraft({ ...draft, baseURL: event.target.value })} placeholder="https://api.deepseek.com/v1" /></Field>
      <Field label="API Key" id="wa-provider-key" help={draft.credentialConfigured ? '已保存密钥；留空保留。更换 API 地址后需为新地址重新保存密钥。' : '测试连接会调用所选模型，可能产生服务商费用。'}><input id="wa-provider-key" className="wa-input" type="password" autoComplete="new-password" value={apiKey} disabled={busy} onChange={event => setApiKey(event.target.value)} placeholder={draft.credentialConfigured ? '已保存，加密存储' : '填写 API Key'} /></Field>
      <Field label="模型 ID，每行一个" id="wa-provider-models"><textarea id="wa-provider-models" className="wa-textarea" rows={3} required value={modelText} disabled={busy} onChange={event => setModelText(event.target.value)} placeholder="填写服务商提供的准确模型名称" /></Field>
      {models.map(model => <div className="wa-row" key={model.id}>
        <label className="wa-check-row"><input type="checkbox" checked={model.vision === true} disabled={busy} onChange={event => setDraft({ ...draft, models: models.map(value => value.id === model.id ? { ...value, vision: event.target.checked } : value) })} />{model.id} 支持图片输入</label>
        <input className="wa-input" aria-label={model.id + ' 推理强度'} placeholder="可选推理强度，如 low,medium,high" value={(model.reasoningEfforts ?? []).join(',')} disabled={busy} onChange={event => setDraft({ ...draft, models: models.map(value => value.id === model.id ? { ...value, reasoningEfforts: event.target.value.split(',') } : value) })} />
      </div>)}
      <div className="wa-row">
        <label className="wa-check-row"><input type="checkbox" checked={draft.stream} disabled={busy} onChange={event => setDraft({ ...draft, stream: event.target.checked })} />使用流式接口</label>
        <label className="wa-check-row"><input type="checkbox" checked={!draft.requiresKey} disabled={busy} onChange={event => setDraft({ ...draft, requiresKey: !event.target.checked })} />服务无需 API Key</label>
      </div>
      <div className="wa-row"><Button type="submit" disabled={busy}>{busy ? '处理中…' : '保存服务'}</Button><Button quiet disabled={busy || !providers.some(value => value.id === draft.id)} onClick={test}>测试已保存的连接</Button></div>
      {notice && <p className="wa-help" role="status">{notice}</p>}{error && <p className="wa-alert" role="alert">{error}</p>}
    </form>
  </section>;
}
