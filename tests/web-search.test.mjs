import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchService, SEARCH_CREDENTIALS, webSearchTool, validateModelConfig, searchBaseURL } from '../lib/testing.js';

function credentials(values = {}) {
  const stored = new Map(Object.entries(values)), writes = [];
  return { stored, writes, resolve: async ref => stored.has(ref) ? { value: stored.get(ref), source: 'file' } : undefined,
    describe: async ref => ({ configured: stored.has(ref), writable: true }),
    set: async (ref, value) => { writes.push(ref); stored.set(ref, value); } };
}
const execution = () => ({ signal: new AbortController().signal });

test('search auth failures keep the actionable status and never expose provider messages or credentials', async () => {
  const events = [], secret = 'fixture-private-search-key';
  const result = await webSearchTool(() => ({ search: async () => { throw Object.assign(new Error(`HTTP 401 invalid key ${secret} endpoint https://private.example/${secret}`), { code: 'WEB_PROVIDER_ERROR' }); } }), event => events.push(event)).execute({ query: 'arxiv LIRA' }, execution());
  const value = JSON.parse(result);
  assert.equal(value.ok, false); assert.equal(value.code, 'WEB_SEARCH_AUTH_FAILED'); assert(value.error.includes('HTTP 401'));
  assert(!result.includes(secret)); assert(!JSON.stringify(events).includes(secret));
  assert.equal(events[0].code, value.code); assert(!Object.hasOwn(events[0], 'query'));
});

test('DSH search credential, provider selection, quota and rate failures remain distinguishable', async () => {
  for (const [code, message, expected] of [
    ['WEB_PROVIDER_CREDENTIAL_MISSING', 'missing', 'WEB_PROVIDER_CREDENTIAL_MISSING'],
    ['WEB_PROVIDER_CONFIGURED_MISSING', 'missing', 'WEB_PROVIDER_CONFIGURED_MISSING'],
    ['WEB_PROVIDER_AMBIGUOUS', 'ambiguous', 'WEB_PROVIDER_AMBIGUOUS'],
    ['WEB_PROVIDER_ERROR', 'HTTP 402', 'WEB_SEARCH_QUOTA'],
    ['WEB_PROVIDER_ERROR', 'HTTP 429', 'WEB_SEARCH_RATE_LIMITED'],
    ['WEB_PROVIDER_ERROR', 'HTTP 503', 'WEB_SEARCH_SERVICE_FAILED'],
    ['WEB_PROVIDER_ERROR', 'no web_search_tool_result blocks', 'WEB_SEARCH_UNSUPPORTED'],
  ]) {
    const value = JSON.parse(await webSearchTool(() => ({ search: async () => { throw Object.assign(new Error(message), { code }); } })).execute({ query: '公开问题' }, execution()));
    assert.equal(value.code, expected);
  }
});

test('empty searches are completed without claiming cited sources, and cancellation retains the caller reason', async () => {
  const value = JSON.parse(await webSearchTool(() => ({ search: async () => ({ sources: [] }) })).execute({ query: '公开问题' }, execution()));
  assert.equal(value.ok, true); assert.equal(value.empty, true); assert.deepEqual(value.sources, []);
  const controller = new AbortController(), reason = new Error('fixture cancellation');
  const tool = webSearchTool(() => ({ search: async () => { controller.abort(reason); throw new Error('remote failure'); } }));
  await assert.rejects(tool.execute({ query: '公开问题' }, { signal: controller.signal }), error => error === reason);
});

test('Tavily submits only the selected public query to its saved endpoint with its dedicated credential', async () => {
  const store = credentials({ [SEARCH_CREDENTIALS.tavily]: 'fixture-tavily-key' }), requests = [];
  let hostCalls = 0;
  const service = new SearchService({ credentials: store, web: { search: () => { hostCalls++; } } }, { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ results: [{ title: '公开论文', url: 'https://arxiv.org/abs/fixture', content: '公开摘要' }, { title: '重复', url: 'https://arxiv.org/abs/fixture', content: '重复' }, { url: 'file:///private' }] });
  } });
  const config = { searchProvider: 'tavily', tavilyBaseURL: 'https://search.example/' }, access = service.forConfig(config);
  config.searchProvider = 'dsh'; config.tavilyBaseURL = 'https://other.example';
  const result = await access.search({ query: 'arxiv LIRA', maxResults: 5 }, new AbortController().signal);
  assert.equal(hostCalls, 0); assert.equal(requests[0].url, 'https://search.example/search');
  assert.equal(requests[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].options.body), { api_key: 'fixture-tavily-key', query: 'arxiv LIRA', search_depth: 'basic', max_results: 5, include_answer: false, include_raw_content: false });
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].snippet, '公开摘要');
});

test('missing dedicated credentials never route fallback through the host or a chat credential', async () => {
  let calls = 0;
  const service = new SearchService({ credentials: credentials({ DEEPSEEK_API_KEY: 'fixture-chat-key' }), web: { search: () => { calls++; } } }, { fetchImpl: () => { calls++; } });
  await assert.rejects(service.forConfig({ searchProvider: 'tavily' }).search({ query: '公开问题' }), error => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING');
  assert.equal(calls, 0);
});

test('DeepSeek search posts the query to the Anthropic-compatible endpoint with its dedicated key and caps results', async () => {
  const requests = [], store = credentials({ [SEARCH_CREDENTIALS.deepseek]: 'fixture-deepseek-key', DEEPSEEK_API_KEY: 'fixture-chat-key' });
  let hostCalls = 0;
  const service = new SearchService({ credentials: store, web: { search: () => { hostCalls++; } } }, { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ content: [
      { type: 'web_search_tool_result', tool_use_id: 'toolu', content: Array.from({ length: 8 }, (_, i) => ({ type: 'web_search_result', title: '公开资料 ' + i, url: 'https://example.com/' + i, page_age: '2026' })) },
      { type: 'text', text: '摘要' },
    ] });
  } });
  const result = await service.forConfig({ searchProvider: 'deepseek', deepseekBaseURL: 'https://api.deepseek.com/anthropic/v1', deepseekModel: 'deepseek-v4-flash' })
    .search({ query: '公开问题', maxResults: 5 }, execution().signal);
  assert.equal(hostCalls, 0);
  assert.equal(requests[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.authorization, 'Bearer fixture-deepseek-key');
  assert.equal(requests[0].options.headers['x-api-key'], 'fixture-deepseek-key');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
  assert.deepEqual(body.messages, [{ role: 'user', content: '公开问题' }]);
  assert.equal(result.provider, 'deepseek'); assert.equal(result.sources.length, 5);
  assert.equal(result.sources[0].title, '公开资料 0');
  assert.equal(store.stored.get('DEEPSEEK_API_KEY'), 'fixture-chat-key');
});

test('legacy dsh selections resolve to DeepSeek search instead of a host provider', async () => {
  const requests = [], service = new SearchService({ credentials: credentials({ [SEARCH_CREDENTIALS.deepseek]: 'fixture-deepseek-key' }) }, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: '公开资料', url: 'https://example.com/a' }] }] });
    },
  });
  const result = await service.forConfig({ searchProvider: 'dsh' }).search({ query: '公开问题' }, execution().signal);
  assert.equal(result.provider, 'deepseek'); assert.equal(result.sources.length, 1);
  assert.equal(requests[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
});

test('DeepSeek search reports auth, quota and unusable responses without exposing the key', async () => {
  for (const [response, code] of [
    [new Response('fixture-private-key', { status: 401 }), 'WEB_SEARCH_AUTH_FAILED'],
    [new Response('', { status: 402 }), 'WEB_SEARCH_QUOTA'],
    [new Response('', { status: 429 }), 'WEB_SEARCH_RATE_LIMITED'],
    [Response.json({ content: [{ type: 'text', text: 'no sources' }] }), 'WEB_SEARCH_UNSUPPORTED'],
    [Response.json({ content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }] }), 'WEB_SEARCH_SERVICE_FAILED'],
  ]) {
    const service = new SearchService({ credentials: credentials({ [SEARCH_CREDENTIALS.deepseek]: 'fixture-deepseek-key' }) }, { fetchImpl: async () => response });
    const result = JSON.parse(await webSearchTool(() => service.forConfig({ searchProvider: 'deepseek' })).execute({ query: '公开问题' }, execution()));
    assert.equal(result.code, code); assert(!JSON.stringify(result).includes('fixture-deepseek-key'));
  }
});

test('optional Tavily image search exposes actual image links without changing ordinary search requests', async () => {
  const requests = [], service = new SearchService({ credentials: credentials({ [SEARCH_CREDENTIALS.tavily]: 'fixture-key' }) }, {
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return Response.json({ results: [], images: [{ url: 'https://example.com/a.png', description: '公开作品' }, { url: 'file:///secret' }] }); },
  });
  const result = await service.forConfig({ searchProvider: 'tavily' }).search({ query: '公开作品', includeImages: true }, execution().signal);
  assert.equal(requests[0].include_images, true); assert.equal(result.images.length, 1);
  await service.forConfig({ searchProvider: 'tavily' }).search({ query: '普通查询' }, execution().signal);
  assert.equal(Object.hasOwn(requests[1], 'include_images'), false);
});

test('Tavily HTTP errors and invalid or oversized responses are safe and actionable', async () => {
  for (const [response, code] of [
    [new Response('fixture-private-key', { status: 401 }), 'WEB_SEARCH_AUTH_FAILED'],
    [new Response('', { status: 429 }), 'WEB_SEARCH_RATE_LIMITED'],
    [Response.json({ answer: 'not a cited search result' }), 'WEB_SEARCH_INVALID_RESULT'],
    [new Response('broken json'), 'WEB_SEARCH_INVALID_RESULT'],
    [new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }), 'WEB_SEARCH_RESPONSE_TOO_LARGE'],
  ]) {
    const service = new SearchService({ credentials: credentials({ [SEARCH_CREDENTIALS.tavily]: 'fixture-tavily-key' }) }, { fetchImpl: async () => response });
    const result = JSON.parse(await webSearchTool(() => service.forConfig({ searchProvider: 'tavily' })).execute({ query: '公开问题' }, execution()));
    assert.equal(result.code, code); assert(!JSON.stringify(result).includes('fixture-private-key'));
  }
});

test('search configuration validates HTTPS endpoints and defaults new configurations to Tavily', () => {
  assert.equal(validateModelConfig({ maxTokens: 4096, temperature: null }).searchProvider, 'tavily');
  for (const value of ['http://search.example', 'https://user:key@search.example', 'https://search.example/?api_key=private', 'https://search.example/#private'])
    assert.throws(() => searchBaseURL(value), error => error.code === 'INVALID_SEARCH_CONFIG');
  assert.equal(searchBaseURL('https://search.example/'), 'https://search.example');
  assert.throws(() => validateModelConfig({ maxTokens: 4096, temperature: null, searchProvider: 'arbitrary' }), error => error.code === 'INVALID_SEARCH_CONFIG');
  const deepseek = validateModelConfig({ maxTokens: 4096, temperature: null, searchProvider: 'deepseek' });
  assert.equal(deepseek.searchProvider, 'deepseek');
  assert.equal(deepseek.deepseekBaseURL, 'https://api.deepseek.com/anthropic/v1');
  assert.equal(deepseek.deepseekModel, 'deepseek-v4-flash');
  assert.equal(validateModelConfig({ maxTokens: 4096, temperature: null, searchProvider: 'dsh' }).searchProvider, 'deepseek');
  assert.throws(() => validateModelConfig({ maxTokens: 4096, temperature: null, searchProvider: 'deepseek', deepseekModel: 'two words' }), error => error.code === 'INVALID_SEARCH_CONFIG');
  assert.throws(() => validateModelConfig({ maxTokens: 4096, temperature: null, searchProvider: 'deepseek', deepseekBaseURL: 'http://plain.example' }), error => error.code === 'INVALID_SEARCH_CONFIG');
});

test('search keys are stored through DSH, return only presence, and failed saves preserve existing credentials', async () => {
  const store = credentials(), service = new SearchService({ credentials: store });
  await service.configureCredential('tavily', 'fixture-tavily-key');
  assert.equal(store.stored.get(SEARCH_CREDENTIALS.tavily), 'fixture-tavily-key');
  assert.deepEqual(service.status(), { credentialStore: true, credentials: { deepseek: false, tavily: true } });
  assert(!JSON.stringify(service.status()).includes('fixture-tavily-key'));
  store.set = async () => { throw new Error('fixture-tavily-key private error'); };
  await assert.rejects(service.configureCredential('tavily', 'fixture-replacement'), error => error.code === 'WEB_SEARCH_CREDENTIAL_SAVE_FAILED' && !error.message.includes('fixture-tavily-key'));
  assert.equal(store.stored.get(SEARCH_CREDENTIALS.tavily), 'fixture-tavily-key');
});
