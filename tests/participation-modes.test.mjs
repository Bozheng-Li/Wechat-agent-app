import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../backend/storage/state-store.mjs';
import { WechatChannel } from '../modules/conversation/channel.mjs';
import { emptyNaturalSettings, validateNaturalSettings, validateConversationSettings, participationTriggers } from '../shared/contracts.mjs';
import { configDraft, configPayload } from '../frontend/shared/drafts.mjs';
import { groupReplyModes } from '../frontend/shared/labels.mjs';
import { preserveTimeValues } from '../shared/time-settings.mjs';
import { naturalDecisionInstructions } from '../prompts/conversation/decision.mjs';
import { stickerPng } from './fixtures/stickers.mjs';
import { runLocalAgent } from '../modules/agent/local-loop.mjs';
import { parseNaturalDecision } from '../modules/conversation/natural-chat.mjs';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const owner = { id: 'wxid_participation_fixture', nickname: '测试账号' }, room = 'participation-fixture@chatroom';
const selector = { accountId: owner.id, chatType: 'group', peerId: room };
const config = (mode = 'natural', natural = emptyNaturalSettings()) => ({ mode, intervalMode: 'fixed', fixedMessages: 3,
  minMessages: 3, maxMessages: 3, recordsPath: '', natural });

function fixture(t, input = config()) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'participation-modes-'));
  const clock = { now: Date.parse('2026-11-07T04:00:00Z') };
  t.mock.method(Date, 'now', () => clock.now);
  const store = new StateStore(root), calls = [], sent = [], gates = [];
  store.configure(owner.id, { enabled: true, privatePeers: ['alice'], groups: [room], prompt: '' });
  store.setPersona({ name: '合成助手', aliases: ['测试君'], prompt: '自然接话，不编造事实。' });
  store.setConversationSettings(owner.id, 'group', room, input);
  const transport = { status: () => ({ online: true, account: owner }), send: async value => {
    sent.push(value); return { delivery: 'server-ack', serverMessageIds: ['fixture-ack-' + sent.length] };
  } };
  const runner = { run: async value => {
    calls.push(value); await runner.before?.(value); value.signal.throwIfAborted();
    const raw = value.naturalDecision ? runner.decision ?? '{"action":"reply","text":"这个新话题挺有意思。"}' : '直接回应当前请求。';
    return { text: value.selectReplyText ? value.selectReplyText(raw) : raw };
  } };
  const channel = new WechatChannel({ store, transport, runner, now: () => clock.now, random: () => 0 });
  let serial = 0;
  const message = (text, extras = {}) => ({ id: 'participation-' + ++serial, time: Math.floor(clock.now / 1000),
    direction: 'incoming', chatType: 'group', peerId: room, sender: { id: 'alice', nickname: '测试成员' },
    message: [{ type: 'text', data: { text } }], ...extras });
  const receive = (text, extras) => channel.receive(message(text, extras), owner.id);
  const state = () => store.naturalState(owner.id, 'group', room);
  const advance = async ms => { clock.now += ms; channel.natural.tick(); await channel.whenIdle(); };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await channel.close();
    const target = fs.realpathSync(root), relative = path.relative(base, target);
    assert(relative.startsWith('participation-modes-') && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { root, clock, store, channel, runner, calls, sent, gates, message, receive, advance, state };
}

test('contracts preserve legacy grants while new settings start count-only', () => {
  assert.deepEqual(participationTriggers(validateConversationSettings(config())), { message: true, timer: false, followup: false });
  assert.deepEqual(participationTriggers(validateConversationSettings(config('natural', { messageEnabled: true }))),
    { message: true, timer: false, followup: false }, 'partial new-schema settings never inherit legacy timer permissions');
  const legacy = { ...config(), natural: { fixedMinutes: 17, followupSeconds: 88, activeHours: false } };
  const original = structuredClone(legacy), normalized = validateConversationSettings(legacy);
  assert.deepEqual(participationTriggers(normalized), { message: true, timer: true, followup: true });
  assert.equal(normalized.natural.fixedMinutes, 17); assert.equal(normalized.natural.followupSeconds, 88);
  assert.deepEqual(legacy, original);
  const noNatural = { ...config() }; delete noNatural.natural;
  assert.equal(validateConversationSettings(noNatural).natural.timerEnabled, true, 'old natural without nested settings keeps timer grant');
  assert.equal(validateConversationSettings({ ...noNatural, mode: 'default' }).natural.timerEnabled, false);
  for (const key of ['messageEnabled', 'timerEnabled', 'followupEnabled'])
    assert.throws(() => validateNaturalSettings({ [key]: 'yes' }), { code: 'INVALID_NATURAL_SETTINGS' });
});

test('UI has one participation entry and emits explicit permission-preserving payloads', () => {
  assert.deepEqual(groupReplyModes.map(row => row[0]), ['default', 'nickname', 'natural']);
  assert.equal(groupReplyModes.filter(row => row[1] === '参与群聊').length, 1);
  const legacy = validateConversationSettings(config('participate', { timerEnabled: true, followupEnabled: true,
    minMinutes: 42, maxMinutes: 66, fixedMinutes: 57, minGapMinutes: 8, activeHours: true, startTime: '22:00', endTime: '06:00', followupSeconds: 87 }));
  const draft = configDraft(legacy), next = configPayload(draft);
  assert.equal(legacy.mode, 'participate'); assert.equal(next.mode, 'natural');
  assert.deepEqual(participationTriggers(next), { message: true, timer: false, followup: false });
  for (const key of ['minMinutes', 'maxMinutes', 'fixedMinutes', 'minGapMinutes', 'activeHours', 'startTime', 'endTime', 'followupSeconds'])
    assert.equal(next.natural[key], legacy.natural[key], key);
  for (const key of ['intervalMode', 'fixedMessages', 'minMessages', 'maxMessages']) assert.equal(next[key], legacy[key], key);
  const oldNatural = validateConversationSettings({ ...legacy, mode: 'natural' });
  assert.deepEqual(participationTriggers(configPayload(configDraft(oldNatural))), { message: true, timer: true, followup: true });
  const fresh = configDraft(); fresh.mode = 'natural';
  assert.deepEqual(participationTriggers(configPayload(fresh)), { message: true, timer: false, followup: false });
  assert.deepEqual(validateConversationSettings(next), validateConversationSettings(validateConversationSettings(next)));
  const preserved = preserveTimeValues('natural', { ...next.natural, timerEnabled: true }, legacy.natural);
  assert.equal(preserved.timerEnabled, true, 'time preservation must not overwrite the explicit trigger choice');
  assert.equal(preserved.followupEnabled, false);
});

test('legacy participate remains count-only despite latent timer and followup settings', async t => {
  const f = fixture(t, config('participate', { timerEnabled: true, followupEnabled: true, fixedMinutes: 1, intervalMode: 'fixed', followupSeconds: 120 }));
  f.channel.natural.tick(); await f.advance(3600000); assert.equal(f.calls.length, 0);
  f.receive('测试君，帮我看看'); await f.channel.whenIdle();
  assert.equal(f.calls[0].mode, 'nickname'); assert.equal(f.calls[0].naturalDecision, undefined);
  assert.equal(f.state().followup.remaining, 0); assert.equal(f.state().nextCheckAt, 0);
  f.receive('继续说说？'); f.receive('这个周末去哪'); await f.channel.whenIdle(); assert.equal(f.calls.length, 1);
  f.receive('湖边怎么样'); await f.channel.whenIdle(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].mode, 'participate'); assert.equal(f.calls[1].naturalDecision.trigger, 'count');
  assert.equal(f.calls[1].naturalDecision.allowColdOpening, false);
  await f.advance(3600000); assert.equal(f.calls.length, 2);
  assert.equal(f.channel.natural.summary(selector).nextCheckAt, null);
  const reloaded = new StateStore(f.root).conversationSettings(owner.id, 'group', room);
  assert.equal(reloaded.mode, 'participate'); assert.deepEqual(participationTriggers(reloaded), { message: true, timer: false, followup: false });
});

test('new default opportunities do not duplicate messages, follow up, or run timers', async t => {
  const f = fixture(t); f.channel.natural.tick();
  const first = f.message('新的讨论一'); f.channel.receive(first, owner.id); f.channel.receive(first, owner.id);
  f.receive('新的讨论二'); f.receive('新的讨论三'); await f.channel.whenIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1); assert.equal(f.calls[0].naturalDecision.trigger, 'count');
  assert.equal(f.state().followup.remaining, 0);
  f.receive('听起来不错'); await f.channel.whenIdle(); assert.equal(f.calls.length, 1);
  await f.advance(24 * 3600000); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.store.progress(owner.id, 'group', room), { count: 1, target: 3 });
});

test('all participation opportunities can be disabled without suppressing direct requests', async t => {
  const f = fixture(t, config('natural', { ...emptyNaturalSettings(), messageEnabled: false }));
  for (let i = 0; i < 12; i++) f.receive('普通新消息 ' + i);
  await f.advance(3600000); assert.equal(f.calls.length, 0);
  f.receive('/agent 明确问题'); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.calls[0].naturalDecision, undefined);
});

test('cold timer is explicitly granted and measures silence after a new message', async t => {
  const f = fixture(t, config('natural', { ...emptyNaturalSettings(), messageEnabled: false, timerEnabled: true,
    intervalMode: 'fixed', fixedMinutes: 5, activeHours: false }));
  f.runner.decision = '{"action":"skip","reason":"no_topic","text":""}';
  f.channel.natural.tick(); await f.advance(4 * 60000); f.receive('群里还在聊天');
  await f.advance(60000); assert.equal(f.calls.length, 0);
  await f.advance(4 * 60000); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.calls[0].naturalDecision.trigger, 'timer'); assert.equal(f.calls[0].naturalDecision.allowColdOpening, true);
});

for (const [label, parts] of [['file', [{ type: 'file', data: { name: 'fixture.txt' } }]],
  ['unsupported', [{ type: 'text', data: { text: '无法显示此消息，你目前使用的微信版本暂时不支持此类型的信息。' } }]]])
  test(`a real ${label} message postpones cold opening even when its content is not a reply topic`, async t => {
    const f = fixture(t, config('natural', { ...emptyNaturalSettings(), messageEnabled: false, timerEnabled: true,
      intervalMode: 'fixed', fixedMinutes: 5, activeHours: false }));
    f.runner.decision = '{"action":"skip","reason":"no_topic","text":""}';
    f.channel.natural.tick(); await f.advance(4 * 60000);
    f.receive('', { message: parts });
    await f.advance(60000); assert.equal(f.calls.length, 0);
    assert.equal(f.state().humanRevision, 1);
    await f.advance(4 * 60000); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
  });

for (const [label, parts] of [['file', [{ type: 'file', data: { name: 'fixture.txt' } }]],
  ['unsupported', [{ type: 'text', data: { text: '无法显示此消息，你目前使用的微信版本暂时不支持此类型的信息。' } }]]])
  test(`a real ${label} message retracts an already queued cold opening`, async t => {
    const f = fixture(t, config('natural', { ...emptyNaturalSettings(), messageEnabled: false, timerEnabled: true,
      intervalMode: 'fixed', fixedMinutes: 1, activeHours: false }));
    const gate = Promise.withResolvers(), reached = Promise.withResolvers(); f.gates.push(gate);
    f.runner.before = async input => { if (input.text === '占用模型') { reached.resolve(); await gate.promise; } };
    f.channel.natural.tick();
    f.receive('占用模型', { chatType: 'private', peerId: 'alice' }); await reached.promise;
    f.clock.now += 60000; f.channel.natural.tick();
    assert.equal(f.channel.queue.length, 1);
    const timerKey = f.channel.queue[0].record.key;
    f.receive('', { message: parts });
    assert.equal(f.channel.queue.length, 0);
    assert.equal(f.state().pendingKey, null);
    assert.equal(f.state().humanRevision, 1);
    assert.equal(f.state().nextCheckAt, f.clock.now + 60000);
    assert.equal(f.store.data.records.find(record => record.key === timerKey).state, 'cancelled');
    gate.resolve(); await f.channel.whenIdle();
    assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  });

test('count and timer opportunities coalesce, then direct mentions cancel that queued turn', async t => {
  const f = fixture(t, config('natural', { ...emptyNaturalSettings(), timerEnabled: true, activeHours: false }));
  const gate = Promise.withResolvers(), reached = Promise.withResolvers(); f.gates.push(gate);
  f.runner.before = async input => { if (input.text === '占用模型') { reached.resolve(); await gate.promise; } };
  f.receive('占用模型', { chatType: 'private', peerId: 'alice' }); await reached.promise;
  for (const text of ['群内消息一', '群内消息二', '群内消息三']) f.receive(text);
  const activeConfig = f.store.conversationSettings(owner.id, 'group', room);
  f.channel.enqueueNatural({ selector, config: activeConfig, state: f.state(), trigger: 'timer' });
  assert.equal(f.channel.queue.length, 1); assert.equal(f.channel.queue[0].record.batches, 2);
  assert.deepEqual(f.channel.queue[0].record.naturalTriggers, ['count', 'timer']);
  f.receive('直接提问', { message: [{ type: 'at', data: { qq: owner.id } }, { type: 'text', data: { text: '直接提问' } }] });
  assert.equal(f.channel.queue.length, 1); assert.equal(f.channel.queue[0].mode, 'default');
  assert.equal(f.channel.queue[0].naturalDecision, undefined);
  gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.calls.length, 2); assert.equal(f.sent.length, 2);
  assert(f.store.data.records.some(record => record.state === 'cancelled' && record.naturalTrigger === 'count'));
});

test('enabling timers does not grant cold-opening content to a count opportunity', async t => {
  const f = fixture(t, config('natural', { ...emptyNaturalSettings(), timerEnabled: true, activeHours: false }));
  for (const text of ['新话题一', '新话题二', '新话题三']) f.receive(text);
  await f.channel.whenIdle(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].naturalDecision.trigger, 'count'); assert.equal(f.calls[0].naturalDecision.allowColdOpening, false);
  assert.match(f.calls[0].text, /没有冷场机会/);
});

test('new human activity retracts a queued timer-only opportunity instead of interrupting live chat', async t => {
  const f = fixture(t, config('natural', { ...emptyNaturalSettings(), timerEnabled: true,
    intervalMode: 'fixed', fixedMinutes: 1, activeHours: false }));
  f.channel.natural.tick();
  const gate = Promise.withResolvers(), reached = Promise.withResolvers(); f.gates.push(gate);
  f.runner.before = async input => { if (input.text === '占用模型') { reached.resolve(); await gate.promise; } };
  f.receive('占用模型', { chatType: 'private', peerId: 'alice' }); await reached.promise;
  f.clock.now += 60000; f.channel.natural.tick();
  assert.equal(f.channel.queue.length, 1); assert.equal(f.channel.queue[0].naturalDecision.allowColdOpening, true);
  const timerKey = f.channel.queue[0].record.key;
  f.receive('群里重新开始讨论了');
  assert.equal(f.channel.queue.length, 0); assert.equal(f.state().pendingKey, null);
  assert.equal(f.state().nextCheckAt, f.clock.now + 60000);
  assert.equal(f.store.data.records.find(record => record.key === timerKey).state, 'cancelled');
  gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.sent.map(value => value.peerId), ['alice']);
});

test('new human activity removes a merged timer but retains the earned queued count opportunity', async t => {
  const f = fixture(t, config('natural', { ...emptyNaturalSettings(), timerEnabled: true,
    intervalMode: 'fixed', fixedMinutes: 1, activeHours: false }));
  const gate = Promise.withResolvers(), reached = Promise.withResolvers(); f.gates.push(gate);
  f.runner.before = async input => { if (input.text === '占用模型') { reached.resolve(); await gate.promise; } };
  f.receive('占用模型', { chatType: 'private', peerId: 'alice' }); await reached.promise;
  for (const text of ['话题一', '话题二', '话题三']) f.receive(text);
  f.clock.now += 60000; f.channel.natural.tick();
  assert.equal(f.channel.queue.length, 1);
  const countKey = f.channel.queue[0].record.key;
  assert.deepEqual(f.channel.queue[0].record.naturalTriggers, ['count', 'timer']);
  assert.equal(f.channel.queue[0].naturalDecision.allowColdOpening, true);
  f.receive('最新讨论：我们现在聊路线');
  assert.equal(f.channel.queue.length, 1); assert.equal(f.channel.queue[0].record.key, countKey);
  assert.deepEqual(f.channel.queue[0].record.naturalTriggers, ['count']);
  assert.equal(f.channel.queue[0].naturalDecision.allowColdOpening, false);
  assert.match(f.channel.queue[0].text, /没有冷场机会/);
  gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.calls.length, 2); assert.equal(f.sent.length, 2);
  assert.equal(f.calls[1].naturalDecision.trigger, 'count'); assert.equal(f.calls[1].naturalDecision.allowColdOpening, false);
  assert(f.calls[1].history.some(entry => entry.text === '最新讨论：我们现在聊路线'));
});

test('remote commands retract queued cold openings while storing no ordinary message observation', async t => {
  const f = fixture(t, config('natural', { ...emptyNaturalSettings(), messageEnabled: false, timerEnabled: true,
    intervalMode: 'fixed', fixedMinutes: 1, activeHours: false }));
  t.mock.method(f.channel, 'drain', () => {});
  f.channel.natural.tick(); f.clock.now += 60000; f.channel.natural.tick();
  assert.equal(f.channel.queue.length, 1);
  const timerKey = f.channel.queue[0].record.key, command = f.message('/dsh tasks');
  f.channel.receive(command, owner.id);
  assert.equal(f.store.data.records.find(record => record.key === timerKey).state, 'cancelled');
  assert.equal(f.state().pendingKey, null); assert.equal(f.state().humanRevision, 1);
  assert.equal(f.state().nextCheckAt, f.clock.now + 60000);
  assert.equal(f.channel.queue.length, 1); assert.equal(f.channel.queue[0].remoteCommand.action, 'tasks');
  assert.equal(f.store.data.records.at(-1).remoteQuery, 'tasks');
  assert.deepEqual(f.store.history(owner.id, 'group', room), []);
  assert.deepEqual(f.channel.memory.load(selector).entries, []);
  f.channel.receive(command, owner.id);
  assert.equal(f.state().humanRevision, 1, 'duplicate remote commands must not reschedule participation twice');
  assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
});

test('a direct nickname aborts an in-flight optional participation before sending', async t => {
  const f = fixture(t, config('participate'));
  const gate = Promise.withResolvers(), reached = Promise.withResolvers(); f.gates.push(gate);
  f.runner.before = async input => { if (input.naturalDecision) { reached.resolve(); await gate.promise; } };
  for (const text of ['普通话题一', '普通话题二', '普通话题三']) f.receive(text);
  await reached.promise; f.receive('测试君，直接帮我'); gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.calls.at(-1).mode, 'nickname');
  assert.equal(f.calls.at(-1).naturalDecision, undefined);
});

for (const mode of ['participate', 'natural']) for (const action of ['reply', 'skip'])
  test(`${mode} selected sticker is expression only; ${action} controls actual delivery`, async t => {
    const f = fixture(t, config(mode));
    f.channel.library.import(owner.id, { name: '测试点头.png', kind: 'sticker', data: stickerPng().toString('base64') });
    const asset = f.channel.library.list(owner.id).items[0];
    f.channel.library.edit(owner.id, asset.id, { description: '点头表示赞同', usage: '感谢与赞同' });
    f.runner.run = async input => {
      f.calls.push(input);
      const choose = input.tools.find(tool => tool.name === 'wechat_sticker_send'); assert(choose);
      assert(!input.tools.some(tool => ['wechat_generate_image', 'wechat_reply_media', 'wechat_task'].includes(tool.name)));
      await choose.execute({ assetId: asset.id, caption: null }, { signal: input.signal });
      return { text: input.selectReplyText(action === 'reply' ? '{"action":"reply","text":""}' : '{"action":"skip","reason":"closed","text":""}') };
    };
    for (const text of ['谢谢啦', '辛苦你了', '确实帮了大忙']) f.receive(text);
    await f.channel.whenIdle(); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, action === 'reply' ? 1 : 0);
    assert.equal(f.store.data.records.at(-1).state, action === 'reply' ? 'sent' : 'skipped');
  });

test('ordinary private and default group replies retain voluntary sticker tools without skip envelopes', async t => {
  const f = fixture(t, config('default'));
  f.channel.library.import(owner.id, { name: '普通模式表情.png', kind: 'sticker', data: stickerPng().toString('base64') });
  f.channel.library.edit(owner.id, f.channel.library.list(owner.id).items[0].id, { description: '微笑点头', usage: '问候或感谢' });
  f.receive('/agent 谢谢啦'); f.receive('你好呀', { chatType: 'private', peerId: 'alice' }); await f.channel.whenIdle();
  assert.equal(f.calls.length, 2); assert.equal(f.sent.length, 2);
  for (const input of f.calls) { assert.equal(input.naturalDecision, undefined); assert(input.tools.some(tool => tool.name === 'wechat_sticker_send')); }
});

for (const strategy of ['legacy', 'progressive-v1']) test(`legacy participate runner uses one decision call and safe expression tools: ${strategy}`, async () => {
  const requests = [];
  const runner = { ctx: { llm: { listProviders: () => [{ id: 'test' }], listModels: async () => [{ id: 'model' }] } },
    selection: () => ({ provider: 'test', model: 'model' }),
    getRuntimeSettings: () => ({ persona: { name: '助手', prompt: '' }, modelConfig: { promptStrategy: strategy } }),
    client: { complete: async input => { requests.push(input); return {
      message: { content: '{"action":"skip","reason":"no_topic","text":""}' }, finishReason: 'stop' }; } },
    polishReply: async text => text };
  const names = ['wechat_role_card', 'wechat_sticker_read', 'wechat_sticker_send', 'wechat_task', 'wechat_generate_image'];
  await runLocalAgent(runner, { text: '判断新话题是否值得参与', mode: 'participate',
    naturalDecision: { trigger: 'count', allowColdOpening: false },
    tools: names.map(name => ({ name, description: name, execute: async () => '{}' })),
    selectReplyText: raw => parseNaturalDecision(raw).text, allowEmptyReply: true });
  assert.equal(requests.length, 1);
  const shown = requests[0].tools.map(tool => tool.name);
  assert(!shown.some(name => ['wechat_task', 'wechat_generate_image'].includes(name)));
  assert.match(requests[0].messages[0].content, /只输出一个 JSON 对象/);
  assert.match(requests[0].messages[0].content, /未授权冷场主动开题/);
});

test('participation prompt separates trigger grants, topic judgment and expression', () => {
  const text = naturalDecisionInstructions({ trigger: 'count', allowColdOpening: false, smartSkip: false });
  assert.match(text, /不是直接请求/); assert.match(text, /未授权冷场主动开题/);
  assert.match(text, /不按概率强制发言或使用表情/); assert.match(text, /最终决定 skip 时不会发出/);
  assert.match(naturalDecisionInstructions({ trigger: 'timer', allowColdOpening: true }), /已允许冷场主动开口/);
});
