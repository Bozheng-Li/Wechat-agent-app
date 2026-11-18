import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CredentialStore } from '../backend/platform/credentials.mjs';
import { ModelProviders } from '../backend/platform/providers.mjs';
import { ModelClient, readModelResponse, readResponsesResponse } from '../modules/agent/model-client.mjs';
import { AppAgentRunner } from '../lib/testing.js';
import { stickerPng } from './fixtures/stickers.mjs';

function fixture(t, responses, models = [{ id: 'test-model' }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-app-model-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('wechat-app-model-')); fs.rmSync(root, { recursive: true, force: true }); });
  const encryption = { isAvailable: () => true, encrypt: value => Buffer.from(value.split('').reverse().join('')), decrypt: value => value.toString().split('').reverse().join('') };
  const credentials = new CredentialStore(root, encryption), providers = new ModelProviders(root, credentials), requests = [], urls = [];
  const fetchImpl = async (url, request) => { urls.push(url); requests.push(JSON.parse(request.body)); const value = responses.shift(); if (value instanceof Error) throw value; return Response.json(value); };
  const ctx = { llm: providers, credentials, agentDefaultModel: { currentSelection: () => providers.defaultSelection() } };
  const runner = new AppAgentRunner(ctx, () => null, () => ({ modelConfig: { promptStrategy: 'progressive-v1' } }));
  runner.client = new ModelClient(providers, { fetchImpl });
  return { root, credentials, providers, runner, requests, urls,
    prepare: (extra = {}) => providers.save({ id: 'test', name: '测试', baseURL: 'http://127.0.0.1:12345/v1', models, stream: false, ...extra }, 'test-private-key') };
}
const reply = (content = '你好', calls, finish = calls ? 'tool_calls' : 'stop') => ({ choices: [{ finish_reason: finish, message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const toolCall = (name, args = {}, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const request = options => ({ text: '测试', signal: new AbortController().signal, ...options });

test('provider credentials persist encrypted and endpoint changes never reuse a key', async t => {
  const f = fixture(t, []); await f.prepare();
  assert.equal(JSON.stringify(await f.providers.list()).includes('test-private-key'), false);
  assert.equal(fs.readFileSync(f.providers.file, 'utf8').includes('test-private-key'), false);
  for (const name of fs.readdirSync(path.join(f.root, 'credentials'))) assert.equal(fs.readFileSync(path.join(f.root, 'credentials', name)).includes('test-private-key'), false);
  const restarted = new ModelProviders(f.root, f.credentials); assert.equal((await restarted.selectionRequest({ provider: 'test', model: 'test-model' })).apiKey, 'test-private-key');
  await restarted.save({ ...restarted.get('test'), baseURL: 'http://localhost:12346/v1' });
  await assert.rejects(restarted.selectionRequest({ provider: 'test', model: 'test-model' }), error => error.code === 'MODEL_KEY_MISSING');
});
test('OS encryption failure never falls back to plaintext', async t => {
  const f = fixture(t, []); f.credentials.encryption.isAvailable = () => false;
  await assert.rejects(f.prepare(), error => error.code === 'CREDENTIAL_UNAVAILABLE');
  assert.equal(fs.existsSync(path.join(f.root, 'credentials')), false);
});
test('chat tool results are returned to the same model before final reply', async t => {
  const f = fixture(t, [reply(null, [toolCall('lookup', { q: '约定' })]), reply('约定是明天见。')]); await f.prepare();
  let called = 0;
  const result = await f.runner.run(request({ tools: [{ name: 'lookup', description: '查约定', parameters: { type: 'object' }, execute(args) { called++; assert.equal(args.q, '约定'); return '{"time":"明天"}'; } }] }));
  assert.equal(called, 1); assert.equal(result.text, '约定是明天见。'); assert.equal(result.requestMetrics.length, 2);
  assert.equal(f.requests[1].messages.at(-1).role, 'tool'); assert.equal(f.requests[1].messages.at(-1).tool_call_id, 'call-1');
});
test('high precision uses one fact/tool stage and a persona-only second stage', async t => {
  const plan = JSON.stringify({ request: '对方在说收拾完桌子后找不到笔',
    facts: ['收拾好了桌子', '笔找不到了'], constraints: ['轻松接一句就收住'], unknown: [] });
  const f = fixture(t, [reply(null, [toolCall('lookup')]), reply(plan), reply('桌子净了，笔倒是隐身了。')]); await f.prepare();
  f.runner.getRuntimeSettings = () => ({ persona: { name: '小满', personaMode: 'high-precision', prompt: '喜欢冷幽默。' },
    modelConfig: { promptStrategy: 'progressive-v1' } });
  let called = 0;
  const result = await f.runner.run(request({ tools: [{ name: 'lookup', description: '读一个只读约定', parameters: { type: 'object' },
    execute() { called++; return '只读事实'; } }] }));
  assert.deepEqual({ text: result.text, mode: result.personaMode, passes: result.personaPasses, calls: f.requests.length },
    { text: '桌子净了，笔倒是隐身了。', mode: 'high-precision', passes: 2, calls: 3 });
  assert.equal(called, 1); assert.equal(result.requestMetrics.length, 3);
  assert.match(f.requests[0].messages[0].content, /第一阶段/); assert.doesNotMatch(f.requests[0].messages[0].content, /喜欢冷幽默/);
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /小满/);
  assert.deepEqual(f.requests[2].tools ?? [], []); assert.match(f.requests[2].messages[0].content, /喜欢冷幽默/);
  assert.match(f.requests[2].messages[1].content, /收拾好了桌子/);
  assert.equal(result.requestMetrics[0].personaPass, 'planning');
  assert.equal(result.requestMetrics[2].personaPass, 'expression');
});

test('progressive tools can be loaded and called without granting other capabilities', async t => {
  const f = fixture(t, [reply(null, [toolCall('wechat_capabilities', { modules: ['memory'] })]), reply(null, [toolCall('wechat_memory', {}, 'call-2')]), reply('记住了')]); await f.prepare();
  await f.runner.run(request({ tools: [{ name: 'wechat_memory', description: '记忆', parameters: { type: 'object' }, execute: async () => '{"ok":true}' }] }));
  assert.equal(f.requests[0].tools.some(tool => tool.function.name === 'wechat_memory'), false);
  assert.equal(f.requests[1].tools.some(tool => tool.function.name === 'wechat_memory'), true);
});
test('invalid or duplicate tool batch performs no operations', async t => {
  const f = fixture(t, [reply(null, [toolCall('lookup'), toolCall('shell', {}, 'call-2')])]); await f.prepare(); let called = 0;
  await assert.rejects(f.runner.run(request({ tools: [{ name: 'lookup', parameters: {}, execute() { called++; } }] })), error => error.code === 'MODEL_TOOLS_INVALID');
  assert.equal(called, 0);
});
test('authorization is checked again after generation and before tools', async t => {
  const f = fixture(t, [reply(null, [toolCall('lookup')])]); await f.prepare(); let allowed = true, called = 0;
  const complete = f.runner.client.complete.bind(f.runner.client);
  f.runner.client.complete = async options => { const value = await complete(options); allowed = false; return value; };
  await assert.rejects(f.runner.run(request({ assertAllowed() { if (!allowed) throw new Error('revoked'); }, tools: [{ name: 'lookup', parameters: {}, execute() { called++; } }] })), /revoked/);
  assert.equal(called, 0);
});
test('empty final after a tool does not replay tool side effects', async t => {
  const f = fixture(t, [reply(null, [toolCall('lookup')]), reply('')]); await f.prepare(); let called = 0;
  await assert.rejects(f.runner.run(request({ tools: [{ name: 'lookup', parameters: {}, execute() { called++; return 'ok'; } }] })), error => error.code === 'MODEL_EMPTY');
  assert.equal(called, 1); assert.equal(f.requests.length, 2);
});
test('a tool-free empty completion retries once and truncated output is never accepted', async t => {
  const f = fixture(t, [reply(''), reply('好了'), reply('未完成', null, 'length')]); await f.prepare();
  assert.equal((await f.runner.run(request())).emptyResponseRetries, 1);
  await assert.rejects(f.runner.run(request()), error => error.code === 'MODEL_INCOMPLETE');
});
test('explicit visual model receives image bytes and tool-only internal tasks stay isolated', async t => {
  const f = fixture(t, [reply('图片说明'), reply('{}')], [{ id: 'test-model' }, { id: 'vision', vision: true }]); await f.prepare();
  await f.runner.run(request({ mode: 'vision', systemOverride: '识图', images: [{ mediaType: 'image/png', data: stickerPng().toString('base64') }] }));
  assert.equal(f.requests[0].model, 'vision'); assert.equal(f.requests[0].messages[1].content[1].type, 'image_url');
  await f.runner.run(request({ mode: 'role-memory', tools: [{ name: 'shell', parameters: {}, execute() { throw Error(); } }] }));
  assert.equal(f.requests[1].tools, undefined);
});
test('SSE reconstructs split text, tool calls and usage', async () => {
  const frames = [
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"问题"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { total_tokens: 15 } },
  ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(frames);
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } });
  const value = await readModelResponse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(value.message.content, '你好'); assert.equal(value.message.tool_calls[0].function.arguments, '{"q":"问题"}'); assert.equal(value.usage.total_tokens, 15);
});
test('truncated SSE and HTTP errors do not expose or return partial responses', async () => {
  await assert.rejects(readModelResponse(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } })), error => error.code === 'MODEL_STREAM_INCOMPLETE');
  await assert.rejects(readModelResponse(new Response('secret diagnostic', { status: 401 })), error => error.code === 'MODEL_HTTP' && !error.message.includes('secret'));
});

test('editing an endpoint during a tool loop affects only the next run', async t => {
  const f = fixture(t, [reply(null, [toolCall('lookup')]), reply('完成')]); await f.prepare();
  const destinations = [], original = f.runner.client.fetch;
  f.runner.client.fetch = async (url, options) => { destinations.push(url); return original(url, options); };
  await f.runner.run(request({ tools: [{ name: 'lookup', parameters: { type: 'object' }, execute: async () => {
    await f.providers.save({ ...f.providers.get('test'), baseURL: 'http://127.0.0.1:54321/v1' }); return 'ok';
  } }] }));
  assert.deepEqual(destinations, ['http://127.0.0.1:12345/v1/chat/completions', 'http://127.0.0.1:12345/v1/chat/completions']);
  await assert.rejects(f.runner.run(request()), error => error.code === 'MODEL_KEY_MISSING');
  assert.equal(destinations.length, 2);
});

const responsesReply = (text, calls, status = 'completed') => ({ status, output: [
  ...(text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []),
  ...(calls ?? []).map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })),
], usage: { input_tokens: 10, output_tokens: 5 } });

test('responses format speaks /responses, keeps the same tool loop and posts translated input items', async t => {
  const f = fixture(t, [responsesReply(null, [toolCall('lookup', { q: '约定' })]), responsesReply('约定是明天见。')]);
  await f.prepare({ apiFormat: 'responses' });
  let called = 0;
  const result = await f.runner.run(request({ tools: [{ name: 'lookup', description: '查约定', parameters: { type: 'object' },
    execute(args) { called++; assert.equal(args.q, '约定'); return '{"time":"明天"}'; } }] }));
  assert.equal(called, 1); assert.equal(result.text, '约定是明天见。');
  assert.deepEqual(f.urls, ['http://127.0.0.1:12345/v1/responses', 'http://127.0.0.1:12345/v1/responses']);
  assert.deepEqual(f.requests[0].tools, [{ type: 'function', name: 'lookup', description: '查约定', parameters: { type: 'object' } }]);
  assert.equal(f.requests[0].tool_choice, 'auto'); assert.equal(f.requests[0].messages, undefined);
  assert.equal(f.requests[0].input[0].role, 'system');
  assert.deepEqual(f.requests[1].input.slice(-2), [
    { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"q":"约定"}' },
    { type: 'function_call_output', call_id: 'call-1', output: '{"time":"明天"}' },
  ]);
});

test('responses SSE reassembles deltas and keeps the completed tool call', async () => {
  const frames = [
    { type: 'response.output_text.delta', delta: '你好' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'call-9', name: 'lookup', arguments: '{"q":"问题"}' }], usage: { total_tokens: 15 } } },
  ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(frames);
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 9) controller.enqueue(bytes.slice(i, i + 9)); controller.close(); } });
  const value = await readResponsesResponse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(value.finishReason, 'tool_calls'); assert.equal(value.message.tool_calls[0].function.arguments, '{"q":"问题"}');
  assert.equal(value.usage.total_tokens, 15);
  await assert.rejects(readResponsesResponse(new Response('data: {"type":"response.failed"}\n\n', { headers: { 'content-type': 'text/event-stream' } })),
    error => error.code === 'MODEL_RESPONSE');
});

test('provider format defaults to chat, persists, and a pasted endpoint suffix is normalized', async t => {
  const f = fixture(t, []);
  await f.prepare();
  assert.equal(f.providers.get('test').apiFormat, 'chat');
  const saved = await f.providers.save({ id: 'test', name: '测试', baseURL: 'http://127.0.0.1:12345/v1/responses', models: [{ id: 'm' }], apiFormat: 'responses' }, 'test-private-key');
  assert.equal(saved.providers[0].baseURL, 'http://127.0.0.1:12345/v1');
  assert.equal(saved.providers[0].apiFormat, 'responses');
});

const factPlan = () => JSON.stringify({ request: '对方在闲聊',
  facts: ['对方泡好了面', '调料包还没拆'], constraints: ['不要给建议'], unknown: [] });

test('standard and high precision can be compared on the same request without app experiment settings', async t => {
  const f = fixture(t, [reply('标准回答'), reply(factPlan()), reply('人设回答')]); await f.prepare();
  const persona = { name: '测试角色', prompt: '轻松简短' };
  const a = await f.runner.run(request({ persona: { ...persona, personaMode: 'standard' } }));
  const b = await f.runner.run(request({ persona: { ...persona, personaMode: 'high-precision' } }));
  assert.equal(a.text, '标准回答'); assert.equal(a.requestMetrics.length, 1);
  assert.equal(b.text, '人设回答'); assert.equal(b.requestMetrics.length, 2);
});

test('a stage-one answer is corrected once instead of being reused as the reply', async t => {
  // First attempt writes a generic reply; the retry returns a proper packet.
  const f = fixture(t, [reply('面泡上了，调料包还在旁边。'), reply(factPlan()), reply('调料包还在旁边看戏。')]);
  await f.prepare();
  const options = { persona: { name: '角色', prompt: '短句', personaMode: 'high-precision' } };
  const result = await f.runner.run(request(options));
  assert.equal(result.text, '调料包还在旁边看戏。');
  assert.equal(f.requests.length, 3);
  assert.match(f.requests[1].messages.at(-1).content, /不要写任何回复内容/);
});

test('a second unusable first pass fails instead of sending the generic wording', async t => {
  const bad = fixture(t, [reply('还是写成了回复。'), reply('又不合格。')]); await bad.prepare();
  await assert.rejects(bad.runner.run(request({ persona: { name: '角色', prompt: '短句', personaMode: 'high-precision' } })),
    { code: 'PERSONA_PLAN_INVALID' });
  assert.equal(bad.requests.length, 2);
  const empty = fixture(t, [reply(factPlan()), reply('')]); await empty.prepare();
  await assert.rejects(empty.runner.run(request({ persona: { name: '角色', prompt: '短句', personaMode: 'high-precision' } })),
    { code: 'MODEL_EMPTY' });
  assert.equal(empty.requests.length, 2);
});

test('natural skip stays a single decision and reply alone receives the persona expression pass', async t => {
  const f = fixture(t, [reply('{"action":"skip","reason":"unrelated","text":""}'),
    reply(JSON.stringify({ action: 'reply', text: '本轮话题', packet: JSON.parse(factPlan()) })), reply('自然接话')]); await f.prepare();
  let selections = 0;
  const options = { persona: { name: '角色', prompt: '简短', personaMode: 'high-precision' }, mode: 'natural',
    naturalDecision: { trigger: 'followup', temperament: 'balanced' }, allowEmptyReply: true,
    selectReplyText: raw => { selections++; return JSON.parse(raw).text || ''; } };
  assert.equal((await f.runner.run(request(options))).text, '');
  assert.equal(f.requests.length, 1);
  assert.equal((await f.runner.run(request(options))).text, '自然接话');
  assert.equal(selections, 2); assert.equal(f.requests.length, 3);
});

test('selected media caption gets persona expression while an image-only reply stays empty', async t => {
  const f = fixture(t, [reply(factPlan()), reply('更自然的配文'), reply('不应发送的正文')]); await f.prepare();
  let caption = '原始配文';
  const options = { persona: { name: '角色', prompt: '简短', personaMode: 'high-precision' }, allowEmptyReply: true,
    selectedReply: () => ({ text: caption, description: '实际素材说明' }), selectReplyText: () => caption };
  const first = await f.runner.run(request(options));
  assert.equal(first.text, '更自然的配文'); assert.equal(first.personaApplied, true);
  caption = '';
  const second = await f.runner.run(request(options));
  assert.equal(second.text, ''); assert.equal(second.personaApplied, false); assert.equal(f.requests.length, 3);
});

test('revocation during expression prevents a high precision result from being returned', async t => {
  const f = fixture(t, [reply(factPlan()), reply('不得返回')]); await f.prepare();
  let allowed = true, calls = 0;
  const complete = f.runner.client.complete.bind(f.runner.client);
  f.runner.client.complete = async options => { const value = await complete(options); if (++calls === 2) allowed = false; return value; };
  await assert.rejects(f.runner.run(request({ persona: { name: '角色', prompt: '简短', personaMode: 'high-precision' },
    assertAllowed() { if (!allowed) throw new Error('revoked'); } })), /revoked/);
  assert.equal(f.requests.length, 2);
});
