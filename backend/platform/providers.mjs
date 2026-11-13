import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicBytes } from '../storage/atomic-text.mjs';
import { ChannelError } from '../../shared/contracts.mjs';

const fail = message => { throw new ChannelError('PROVIDER_INVALID', message); };
export function modelBaseURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('请输入模型服务的 API 根地址'); }
  if (typeof value !== 'string' || value.length > 2048 || url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    fail('模型服务需要 HTTPS；本机模型可使用 localhost 的 HTTP 地址');
  return url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}
export const providerCredential = provider => 'MODEL_' + createHash('sha256').update(provider.id + '\n' + provider.baseURL).digest('hex');
export function validateProvider(input) {
  if (!input || typeof input !== 'object' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(input.id)) fail('服务编号应为小写字母、数字或短横线');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) fail('请输入服务名称，最多 100 字');
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > 200) fail('请添加至少一个模型，最多 200 个');
  const names = new Set();
  const models = input.models.map(value => {
    const model = typeof value === 'string' ? { id: value } : value;
    if (!model || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200 || /[\s\u0000-\u001f]/u.test(model.id) || names.has(model.id)) fail('模型名称无效或重复');
    names.add(model.id);
    const efforts = model.reasoningEfforts ?? [];
    if (!Array.isArray(efforts) || efforts.length > 12 || efforts.some(e => !/^[a-z0-9_-]{1,30}$/.test(e))) fail('推理强度无效');
    return { id: model.id, name: String(model.name || model.id).slice(0, 200), vision: model.vision === true, reasoningEfforts: [...new Set(efforts)] };
  });
  return { id: input.id, name: input.name.trim(), baseURL: modelBaseURL(input.baseURL), models,
    stream: input.stream !== false, requiresKey: input.requiresKey !== false };
}

export class ModelProviders {
  constructor(root, credentials) {
    this.file = path.join(root, 'providers.json'); this.credentials = credentials; this.queue = Promise.resolve();
    this.providers = [];
    if (fs.existsSync(this.file)) {
      try { this.providers = JSON.parse(fs.readFileSync(this.file, 'utf8')).providers.map(validateProvider); }
      catch { throw new ChannelError('PROVIDERS_UNREADABLE', '模型配置无法读取，原文件已保留；请检查 providers.json'); }
    }
  }
  get(id) {
    const provider = this.providers.find(value => value.id === id);
    if (!provider) throw new ChannelError('MODEL_UNAVAILABLE', '所选模型服务已不存在，请在模型设置中重新选择');
    return structuredClone(provider);
  }
  async list() { return { providers: await Promise.all(this.providers.map(async provider => ({ ...provider, credentialConfigured: (await this.credentials.describe(providerCredential(provider))).configured }))) }; }
  listProviders() { return this.providers.map(({ id, name }) => ({ id, name })); }
  async listModels(provider) { return this.get(provider).models.map(model => ({ ...model, inputModalities: model.vision ? ['text', 'image'] : ['text'] })); }
  async resolveModelInfo(provider, model) {
    const info = (await this.listModels(provider)).find(value => value.id === model);
    if (!info) throw new ChannelError('MODEL_UNAVAILABLE', '所选模型未配置，请检查模型设置');
    return { ...info, reasoning: { efforts: info.reasoningEfforts.map(id => ({ id, name: id })) } };
  }
  defaultSelection() { const first = this.providers[0]; return first ? { provider: first.id, model: first.models[0].id } : null; }
  async catalog() { return { groups: await Promise.all(this.providers.map(async ({ id, name }) => ({ id, name, models: await this.listModels(id) }))), default: this.defaultSelection(), failures: [] }; }
  write(providers) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    atomicBytes(this.file, Buffer.from(JSON.stringify({ version: 1, providers }, null, 2) + '\n'));
    this.providers = providers;
  }
  save(input, apiKey) {
    const operation = this.queue.then(async () => {
      const provider = validateProvider(input);
      if (apiKey !== undefined && apiKey !== '') await this.credentials.set(providerCredential(provider), apiKey);
      const providers = [...this.providers]; const index = providers.findIndex(value => value.id === provider.id);
      if (index < 0) providers.push(provider); else providers[index] = provider;
      this.write(providers);
      return this.list();
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  remove(id) {
    const operation = this.queue.then(async () => {
      const provider = this.providers.find(value => value.id === id);
      if (!provider) throw new ChannelError('MODEL_UNAVAILABLE', '该模型服务已不存在，列表已刷新');
      this.write(this.providers.filter(value => value.id !== provider.id));
      await this.credentials.delete(providerCredential(provider));
      return this.list();
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  /** Ask an OpenAI-compatible endpoint for its model list; never stores the key. */
  async discover(input = {}, signal) {
    const baseURL = modelBaseURL(input.baseURL);
    let apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (!apiKey && typeof input.id === 'string') {
      const saved = this.providers.find(value => value.id === input.id && value.baseURL === baseURL);
      if (saved) apiKey = (await this.credentials.resolve(providerCredential(saved)))?.value || '';
    }
    const headers = { accept: 'application/json' };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    let response;
    try {
      response = await fetch(baseURL + '/models', { headers, signal: AbortSignal.any([AbortSignal.timeout(25000), ...(signal ? [signal] : [])]) });
    } catch { throw new ChannelError('PROVIDER_DISCOVER_FAILED', '无法连接该地址，请检查网络、地址与服务状态'); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new ChannelError('PROVIDER_DISCOVER_DENIED', '服务拒绝了这次请求（' + response.status + '），请检查 API 密钥');
      throw new ChannelError('PROVIDER_DISCOVER_FAILED', '服务返回 ' + response.status + '，暂时无法获取模型列表');
    }
    let body;
    try { body = await response.json(); } catch { throw new ChannelError('PROVIDER_DISCOVER_FAILED', '服务返回的内容无法解析为模型列表'); }
    const rows = Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.models) ? body.models
        : Array.isArray(body) ? body : [];
    const seen = new Set(), models = [];
    for (const row of rows) {
      const id = typeof row === 'string' ? row : String(row?.id ?? row?.name ?? '');
      if (!id || id.length > 200 || /[\s\u0000-\u001f]/u.test(id) || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, name: String((typeof row === 'object' && row?.name) || id).slice(0, 200) });
      if (models.length >= 500) break;
    }
    return { models };
  }
  async selectionRequest(selection) {
    const provider = this.get(selection.provider);
    const model = provider.models.find(value => value.id === selection.model);
    if (!model) throw new ChannelError('MODEL_UNAVAILABLE', '所选模型未配置');
    const apiKey = (await this.credentials.resolve(providerCredential(provider)))?.value;
    if (provider.requiresKey && !apiKey) throw new ChannelError('MODEL_KEY_MISSING', '请先在模型设置中保存此服务的 API Key');
    return { provider, model, apiKey };
  }
}
