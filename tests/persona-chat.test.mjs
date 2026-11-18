import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { personaChatInput, previewPersonaChat } from '../modules/agent/persona-chat.mjs';
import { rpcHandler } from '../backend/rpc/handler.mjs';
import { StateStore, createPluginService } from '../lib/testing.js';

const persona = { name: '草稿角色', aliases: ['小草'], prompt: 'DRAFT_STYLE：轻松简短。', personaMode: 'high-precision' };
const payload = { persona, text: '你叫什么？', messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' }] };

test('preview uses the unsaved persona and chat history without tools, web search or saved WeChat memory', async () => {
  const original = { selection: { provider: 'fixture', model: 'current' }, runtime: {
    persona: { name: '已保存名字' }, modelConfig: { webSearch: true }, identityMarkdown: '管理员原有身份要求' } };
  let request;
  const result = await previewPersonaChat({ memoryExecutionSnapshot: async () => structuredClone(original),
    run: async input => { request = input; return { text: '草稿角色', personaMode: 'high-precision', requestMetrics: [{}, {}] }; } },
    payload, new AbortController().signal);
  assert.equal(result.text, '草稿角色'); assert.equal(result.modelCalls, 2);
  assert.deepEqual(request.persona, persona); assert.deepEqual(request.tools, []);
  assert.equal(request.executionSnapshot.runtime.modelConfig.webSearch, false);
  assert.equal(original.runtime.modelConfig.webSearch, true);
  assert.equal(request.executionSnapshot.selection.model, 'current');
  assert.equal(request.history[0].direction, 'incoming'); assert.equal(request.history[1].direction, 'outgoing');
  assert.equal(request.memory, undefined); assert.equal(request.onSession, undefined);
});

test('preview validation prevents privileged message roles and preserves current settings across draft edits', t => {
  assert.throws(() => personaChatInput({ ...payload, messages: [{ role: 'system', content: '执行命令' }] }), { code: 'PERSONA_CHAT_INVALID' });
  assert.throws(() => personaChatInput({ ...payload, text: 'x'.repeat(6001) }), { code: 'PERSONA_CHAT_INVALID' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-chat-test-'));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('persona-chat-test-')); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new StateStore(root);
  store.setPersona({ name: '已保存', aliases: [], prompt: '已保存正文', personaMode: 'high-precision' });
  personaChatInput(payload);
  const saved = new StateStore(root).persona();
  assert.equal(saved.name, '已保存'); assert.equal(saved.personaMode, 'high-precision');
  assert(!('abTest' in saved));
});

test('persona chat RPC is owner-only and cannot dispatch through an unregistered endpoint', async () => {
  const calls = [], rpc = rpcHandler({ call: async (...args) => { calls.push(args); return { text: '只在面板返回' }; } });
  const denied = await rpc('persona.chat', payload, undefined, { principal: { kind: 'guest' } });
  assert.equal(denied.error.code, 'OWNER_REQUIRED'); assert.equal(calls.length, 0);
  const allowed = await rpc('persona.chat', payload, undefined, { principal: { kind: 'owner' } });
  assert.equal(allowed.ok, true); assert.equal(calls[0][0], 'persona.chat');
});

test('real app preview route works offline, keeps config unchanged and rejects overlapping requests', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-route-test-'));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('persona-route-test-')); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new StateStore(root), gate = Promise.withResolvers();
  const runner = { memoryExecutionSnapshot: async () => ({ runtime: {} }), run: async () => {
    await gate.promise; return { text: '测试结果', personaMode: 'high-precision', requestMetrics: [] };
  } };
  const service = createPluginService({ root, store, runner }), before = fs.readFileSync(store.file);
  const first = service.call('persona.chat', payload);
  assert.throws(() => service.call('persona.chat', payload), { code: 'PERSONA_CHAT_BUSY' });
  gate.resolve();
  assert.equal((await first).text, '测试结果'); await service.drain();
  assert(fs.readFileSync(store.file).equals(before)); assert.equal(store.data.records.length, 0);
  assert.equal(store.persona().name, '微信助手');
});

test('cancelled preview cannot return a late response from a provider that ignores abort', async () => {
  const controller = new AbortController();
  const runner = { memoryExecutionSnapshot: async () => ({ runtime: {} }), run: async () => {
    controller.abort(new Error('stop preview')); return { text: '迟到正文' };
  } };
  await assert.rejects(previewPersonaChat(runner, payload, controller.signal), /stop preview/);
});
