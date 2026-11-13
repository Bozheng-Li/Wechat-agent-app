import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel } from '../lib/testing.js';
import { registerModelTools } from '../modules/tools/registry.mjs';

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-quiet-'));
  const store = new StateStore(root), sent = [], requests = [], scope = { accountId: 'self', chatType: 'private', peerId: 'alice', senderId: 'alice' };
  store.configure('self', { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  store.setConversationSettings('self', 'private', 'alice', {
    ...store.conversationSettings('self', 'private', 'alice'), remoteEnabled: true, adminIds: ['alice'],
  });
  const runner = { run: async input => { requests.push(input); return { text: '最终结果' }; } };
  const channel = new WechatChannel({ store, runner, transport: {
    status: () => ({ online: true, account: { id: 'self' } }),
    send: async request => { sent.push(request); return { delivery: 'server-ack', serverMessageIds: ['ack-' + sent.length] }; },
  } });
  let serial = 0;
  const receive = text => channel.receive({ id: 'message-' + ++serial, time: Math.floor(Date.now() / 1000),
    direction: 'incoming', chatType: 'private', peerId: 'alice', sender: { id: 'alice' },
    message: [{ type: 'text', data: { text } }] }, 'self');
  t.after(async () => { await channel.close(); assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, channel, runner, sent, requests, scope, receive };
}

async function enteredRunner(f, entered) {
  await Promise.race([entered.promise, f.channel.whenIdle().then(() => assert.fail('expected runner did not start'))]);
}

test('chat tools and retries stay silent until one final reply with its own ACK', { timeout: 120000 }, async t => {
  const f = fixture(t), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  f.runner.run = async input => {
    for (const name of ['wechat_file', 'wechat_file', 'wechat_capabilities', 'wechat_memory', 'wechat_web_search'])
      await input.onBeforeTool(name, { action: 'list' }, { signal: input.signal, callId: name });
    entered.resolve(); await finish.promise; return { text: '核对结果' };
  };
  try {
    f.receive('帮我核对资料'); await enteredRunner(f, entered);
    assert.equal(f.sent.length, 0); assert(f.store.data.records.every(record => !record.toolProgress));
  } finally { finish.resolve(); }
  await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].message[0].data.text, '核对结果');
  const record = f.store.data.records.find(record => record.state === 'sent');
  assert.deepEqual(record.acknowledgedMessageIds, ['ack-1']);
});

test('native dispatch keeps authorization checks and quiet guidance for both direct and deferred tools', async () => {
  const hooks = new Map(), events = [], prompts = [], disposers = [], agent = {};
  let allowed = true;
  const ctx = { tools: { restrict() {}, register() {}, guard() {} },
    on(name, callback) { hooks.set(name, callback); return () => hooks.delete(name); },
    systemPrompt: { section(value) { prompts.push(value.text); } } };
  registerModelTools(ctx, [], { agent, quiet: true, onDispose: value => disposers.push(value),
    assertAllowed() { if (!allowed) throw Error('revoked'); },
    onBeforeTool: name => events.push('observed:' + name) });
  await hooks.get('tools/execute')({ agent, name: 'read_file', signal: new AbortController().signal }, async () => events.push('executed'));
  assert.deepEqual(events, ['observed:read_file', 'executed']);
  assert(prompts.some(text => text.includes('静默执行') && text.includes('简短提问')));
  allowed = false;
  await assert.rejects(hooks.get('tools/execute')({ agent, name: 'read_file' }, () => assert.fail('must remain guarded')), /revoked/);
  for (const dispose of disposers.reverse()) dispose();
  registerModelTools(ctx, []);
  assert.equal(prompts.length, 1, 'internal tools do not acquire user-facing reply instructions');
  registerModelTools(ctx, [], { quiet: true });
  assert.equal(prompts.length, 2, 'quiet guidance also applies when no observation callback exists');
  assert(prompts[1].includes('不重复接单') && prompts[1].includes('用户主动询问进度时再回答当前状态'));
});
