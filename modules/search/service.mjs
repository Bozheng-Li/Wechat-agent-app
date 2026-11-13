import { ChannelError, DEFAULT_TAVILY_URL, DEFAULT_DEEPSEEK_URL, DEFAULT_DEEPSEEK_MODEL, searchBaseURL } from "../../shared/contracts.mjs";

import { TIME_DEFAULTS } from '../../shared/time-settings.mjs';

export const SEARCH_CREDENTIALS = Object.freeze({
  deepseek: 'WECHAT_AGENT_DEEPSEEK_SEARCH_API_KEY',
  tavily: 'WECHAT_AGENT_TAVILY_API_KEY',
});
export { DEFAULT_TAVILY_URL, DEFAULT_DEEPSEEK_URL, DEFAULT_DEEPSEEK_MODEL, searchBaseURL };
const MAX_RESPONSE_BYTES = 1024 * 1024;
function boundedImages(values) {
  return (Array.isArray(values) ? values : []).flatMap(value => {
    try { const url = new URL(typeof value === 'string' ? value : value?.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) return [];
      return [{ url: url.href, description: String(value?.description || '').slice(0, 1000) }];
    } catch { return []; }
  }).slice(0, 8);
}

function boundedSources(values, limit) {
  if (!Array.isArray(values))
    throw new ChannelError('WEB_SEARCH_INVALID_RESULT', '搜索服务没有返回有效的结果列表，请核对服务接口。');
  const seen = new Set(),
    sources = [];
  for (const value of values) {
    let url;
    try {
      url = new URL(value?.url);
    } catch {
      continue;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 4096 ||
      seen.has(url.href)
    )
      continue;
    seen.add(url.href);
    sources.push({
      title: String(value.title || '').slice(0, 300),
      url: url.href,
      snippet: String(value.content || value.snippet || '').slice(0, 1500),
    });
    if (sources.length === limit) break;
  }
  return sources;
}

async function responseJSON(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new ChannelError('WEB_SEARCH_RESPONSE_TOO_LARGE', '搜索服务的返回内容过大，请调整查询后重试。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ChannelError('WEB_SEARCH_INVALID_RESULT', '搜索服务返回了空响应，请稍后重试。');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new ChannelError('WEB_SEARCH_RESPONSE_TOO_LARGE', '搜索服务的返回内容过大，请调整查询后重试。');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ChannelError('WEB_SEARCH_INVALID_RESULT', '搜索服务返回的内容无法解析，请核对服务接口。');
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}

/** Independent search credentials; a chat credential is never copied to a new endpoint. */
export class SearchService {
  constructor(ctx, { fetchImpl = globalThis.fetch, loadDeepSeek, attemptTimeoutMs = TIME_DEFAULTS.searchTimeoutSeconds * 1000, getAttemptTimeoutMs } = {}) {
    this.ctx = ctx;
    this.fetchImpl = fetchImpl;
    this.attemptTimeoutMs = attemptTimeoutMs;
    this.getAttemptTimeoutMs = getAttemptTimeoutMs ?? (() => this.attemptTimeoutMs);
    this.credentials = { deepseek: false, tavily: false };
  }
  async refreshCredentials() {
    for (const [provider, ref] of Object.entries(SEARCH_CREDENTIALS)) {
      try {
        this.credentials[provider] = !!(await this.ctx?.credentials?.describe?.(ref))?.configured;
      } catch {
        this.credentials[provider] = false;
      }
    }
    return { ...this.credentials };
  }
  async configureCredential(provider, apiKey, signal) {
    if (
      !Object.hasOwn(SEARCH_CREDENTIALS, provider) ||
      typeof apiKey !== 'string' ||
      !apiKey.trim() ||
      apiKey.length > 512 ||
      /[\u0000-\u0020\u007f]/.test(apiKey.trim())
    )
      throw new ChannelError('INVALID_SEARCH_CREDENTIAL', '请选择搜索服务并填写有效的 API Key，最多 512 字。');
    if (!this.ctx?.credentials?.set)
      throw new ChannelError('WEB_SEARCH_CREDENTIAL_STORE_MISSING', '本地密钥服务尚未就绪，搜索密钥未保存。');
    signal?.throwIfAborted();
    try {
      await this.ctx.credentials.set(SEARCH_CREDENTIALS[provider], apiKey.trim());
    } catch {
      throw new ChannelError('WEB_SEARCH_CREDENTIAL_SAVE_FAILED', '本地应用未能保存搜索密钥，请核对当前凭据状态后重试。');
    }
    await this.refreshCredentials();
  }
  status() {
    return { credentialStore: !!this.ctx?.credentials?.set, credentials: { ...this.credentials } };
  }
  forConfig(config = {}, { assertAllowed = () => {} } = {}) {
    // Bind the configuration when the tool is created: later edits must not
    // silently retarget a search that is already in flight.
    const settings = { ...config };
    return { search: async (request, signal) => {
      assertAllowed(); signal?.throwIfAborted();
      const selected = settings.searchProvider === 'dsh' ? 'deepseek' : settings.searchProvider ?? 'tavily';
      if (!['deepseek', 'tavily'].includes(selected))
        throw new ChannelError('INVALID_SEARCH_CONFIG', '请选择 DeepSeek 搜索或 Tavily。');
      const value = selected === 'deepseek'
        ? await this.searchDeepSeek(settings, request, signal)
        : await this.search(selected, settings.tavilyBaseURL ?? DEFAULT_TAVILY_URL, request, signal);
      assertAllowed(); signal?.throwIfAborted();
      return { ...value, provider: selected, primaryProvider: selected, fallbackUsed: false, fallbackAttempted: false,
        attempts: [{ provider: selected, state: value.sources.length ? 'succeeded' : 'empty', sourceCount: value.sources.length }] };
    } };
  }
  // DeepSeek search runs on the Anthropic-compatible Messages endpoint with the
  // server-side web_search tool; results arrive as web_search_tool_result blocks.
  async searchDeepSeek(config, request, signal) {
    signal?.throwIfAborted();
    const ref = SEARCH_CREDENTIALS.deepseek;
    let apiKey;
    try {
      apiKey = (await this.ctx?.credentials?.resolve?.(ref))?.value;
    } catch {
      throw new ChannelError('WEB_SEARCH_CREDENTIAL_READ_FAILED', '本地应用未能读取 DeepSeek 搜索凭据，请检查凭据服务。');
    }
    signal?.throwIfAborted();
    this.credentials.deepseek = !!apiKey;
    if (!apiKey)
      throw new ChannelError(
        'WEB_PROVIDER_CREDENTIAL_MISSING',
        'DeepSeek 搜索尚未保存 API Key；请在模型设置的搜索密钥中填写 DeepSeek 官方密钥。'
      );
    const baseURL = searchBaseURL(config.deepseekBaseURL ?? DEFAULT_DEEPSEEK_URL, 'DeepSeek');
    const model = String(config.deepseekModel ?? DEFAULT_DEEPSEEK_MODEL).trim() || DEFAULT_DEEPSEEK_MODEL;
    const limit = Math.min(Math.max(Number(request.maxResults) || 5, 1), 10);
    const deadline = new AbortController();
    const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(
      () => deadline.abort(new ChannelError('WEB_SEARCH_TIMEOUT', 'DeepSeek 搜索超时，未取得本次结果。')),
      this.getAttemptTimeoutMs()
    );
    let response;
    try {
      response = await this.fetchImpl(baseURL + '/messages', {
        method: 'POST',
        redirect: 'error',
        signal: combined,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
          authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          stream: false,
          system: 'Search the public web for the topic and answer with a short factual summary.',
          messages: [{ role: 'user', content: request.query }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: limit }],
        }),
      });
    } catch (error) {
      combined.throwIfAborted();
      if (signal?.aborted) throw signal.reason ?? error;
      throw new ChannelError('WEB_SEARCH_SERVICE_FAILED', 'DeepSeek 搜索暂时无法连接，请稍后重试。');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403)
        throw new ChannelError('WEB_SEARCH_AUTH_FAILED', `DeepSeek 搜索接口返回 HTTP ${status}，请核对 DeepSeek API Key 与访问权限。`);
      if (status === 402)
        throw new ChannelError('WEB_SEARCH_QUOTA', 'DeepSeek 搜索接口返回 HTTP 402，请检查账户余额或额度。');
      if (status === 429)
        throw new ChannelError('WEB_SEARCH_RATE_LIMITED', 'DeepSeek 搜索接口返回 HTTP 429，本次查询受到限流，请稍后重试。');
      throw new ChannelError('WEB_SEARCH_SERVICE_FAILED', `DeepSeek 搜索接口返回 HTTP ${status}，本次未取得搜索结果。`);
    }
    const result = await responseJSON(response, combined);
    const blocks = Array.isArray(result.content) ? result.content : [];
    const failures = blocks.flatMap((block) =>
      block?.type === 'web_search_tool_result' && block.content?.type === 'web_search_tool_result_error' ? [block.content] : []
    );
    const found = blocks
      .flatMap((block) => (block?.type === 'web_search_tool_result' && Array.isArray(block.content) ? block.content : []))
      .filter((item) => item?.type === 'web_search_result');
    if (!found.length) {
      if (failures.length)
        throw new ChannelError(
          'WEB_SEARCH_SERVICE_FAILED',
          `DeepSeek 搜索返回错误：${failures[0].error_code || '未知原因'}，本次未取得结果。`
        );
      throw new ChannelError(
        'WEB_SEARCH_UNSUPPORTED',
        'DeepSeek 搜索没有返回可引用的联网结果；请核对该服务地址是否支持 web_search 工具。'
      );
    }
    const sources = boundedSources(found.map((item) => ({ title: item.title, url: item.url, snippet: '' })), limit);
    return {
      sources,
      ...(request.includeImages ? { images: [] } : {}),
      truncated: found.length > limit,
    };
  }
  async search(provider, baseURL, request, signal, { requireCredential = false } = {}) {
    signal?.throwIfAborted();
    const ref = SEARCH_CREDENTIALS[provider];
    if (!ref) throw new ChannelError('INVALID_SEARCH_CONFIG', '请选择已配置的 Tavily 搜索服务。');
    let apiKey;
    try {
      apiKey = (await this.ctx?.credentials?.resolve?.(ref))?.value;
    } catch {
      throw new ChannelError('WEB_SEARCH_CREDENTIAL_READ_FAILED', '本地应用未能读取搜索凭据，请检查凭据服务。');
    }
    signal?.throwIfAborted();
    this.credentials[provider] = !!apiKey;
    if (!apiKey)
      throw new ChannelError(
        'WEB_PROVIDER_CREDENTIAL_MISSING',
        'Tavily 搜索尚未配置密钥；请在模型设置中保存 Tavily API Key。'
      );
    const endpoint = searchBaseURL(baseURL) + '/search';
    const combined = AbortSignal.any([AbortSignal.timeout(this.getAttemptTimeoutMs()), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: combined,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: request.query,
          search_depth: 'basic',
          max_results: Math.min(request.maxResults || 5, 5),
          include_answer: false,
          include_raw_content: false,
          ...(request.includeImages ? { include_images: true, include_image_descriptions: true } : {}),
        }),
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new ChannelError(
        combined.aborted ? 'WEB_SEARCH_TIMEOUT' : 'WEB_SEARCH_FAILED',
        combined.aborted ? 'Tavily 搜索超时，请稍后重试。' : 'Tavily 搜索请求未完成，请检查服务地址与连接。'
      );
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {}
      if ([401, 403].includes(response.status))
        throw new ChannelError(
          'WEB_SEARCH_AUTH_FAILED',
          `Tavily 搜索接口返回 HTTP ${response.status}，请检查 Tavily API Key 与访问权限。`
        );
      if (response.status === 429)
        throw new ChannelError(
          'WEB_SEARCH_RATE_LIMITED',
          'Tavily 搜索接口返回 HTTP 429，本次查询受到限流，请稍后重试。'
        );
      throw new ChannelError(
        'WEB_SEARCH_SERVICE_FAILED',
        `Tavily 搜索接口返回 HTTP ${response.status}，本次未取得搜索结果。`
      );
    }
    const result = await responseJSON(response, combined);
    if (!Array.isArray(result.results))
      throw new ChannelError('WEB_SEARCH_INVALID_RESULT', 'Tavily 接口没有返回有效的搜索结果，请核对服务地址。');
    return {
      sources: boundedSources(result.results, request.maxResults || 5),
      ...(request.includeImages ? { images: boundedImages(result.images) } : {}),
      truncated: result.results.length > (request.maxResults || 5),
    };
  }
}
