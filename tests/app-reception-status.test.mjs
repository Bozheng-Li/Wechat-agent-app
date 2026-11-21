import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { StateStore, WechatChannel } from '../lib/testing.js';
import { recordState, recordSpec } from '../modules/traces/records.mjs';
import { recoveryAllowed } from '../modules/recovery/service.mjs';
import { UNAVAILABLE_MESSAGE_TITLE, UNAVAILABLE_MESSAGE_REASON, UNAVAILABLE_MESSAGE_REPLY } from '../shared/message-content.mjs';

const placeholder = '无法显示此消息，你目前使用的微信版本暂时不支持此类型的信息。';
function fixture(t, { send } = {}) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-reception-status-'));
  const store = new StateStore(root), calls = [], sent = [];
  store.configure('synthetic-owner', { enabled: true, privatePeers: ['synthetic-friend', 'busy-friend'], groups: ['synthetic-room@chatroom'], prompt: '' });
  const runner = { run: async request => { calls.push(request); return { text: '已读到这句文字' }; } };
  const status = { online: true, account: { id: 'synthetic-owner' } };
  const channel = new WechatChannel({ store, runner,
    transport: { status: () => status, send: async input => { sent.push(input); return send ? send(input) : { delivery: 'server-ack', serverMessageIds: ['synthetic-ack-' + sent.length] }; } } });
  let serial = 0;
  const receive = (text, extra = {}) => {
    const message = { id: `synthetic-${++serial}`, direction: 'incoming', time: Math.floor(Date.now()/1000),
      chatType: 'private', peerId: 'synthetic-friend', sender: { id: 'synthetic-friend' }, messageType: 1,
      message: [{ type: 'text', data: { text } }], ...extra };
    channel.receive(message, 'synthetic-owner'); return message;
  };
  t.after(async () => { await channel.close(); assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, channel, runner, status, calls, sent, receive };
}

test('unreadable private messages receive a direct notice with actual ACK and zero model calls', async t => {
  const f = fixture(t); f.receive(placeholder, { partial: true }); await f.channel.whenIdle();
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], { accountId: 'synthetic-owner', chatType: 'private', peerId: 'synthetic-friend', message: [{ type: 'text', data: { text: UNAVAILABLE_MESSAGE_REPLY } }] });
  const record = f.store.data.records[0];
  assert.equal(record.contentUnavailable, true); assert.equal(record.unavailableNotice, true);
  assert.equal(record.state, 'sent'); assert.equal(record.reply, UNAVAILABLE_MESSAGE_REPLY);
  assert.deepEqual(record.acknowledgedMessageIds, ['synthetic-ack-1']); assert.equal(recordState(record), 'completed');
  const trace = (await f.channel.traces.list('synthetic-owner', { preset: 'meaningful' })).items.find(row => row.sourceKey === 'record:' + record.key);
  assert(trace); assert.equal(trace.modelCalls, 0); assert.equal(trace.state, 'completed');
});

test('the same message is acknowledged once, and a later normal request still reaches the model', async t => {
  const f = fixture(t), original = f.receive(placeholder); f.channel.receive(original, 'synthetic-owner'); await f.channel.whenIdle();
  f.channel.receive(original, 'synthetic-owner'); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.store.data.records.length, 1);
  assert.equal(new StateStore(f.root).data.records.length, 1, 'deduplication state survives reopening');
  f.receive('看得到么'); await f.channel.whenIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].text, '看得到么'); assert.equal(f.sent.length, 2);
});

test('unconfirmed notice delivery remains unknown and is never automatically repeated or called informed', async t => {
  const f = fixture(t, { send: () => ({ delivery: 'unknown', serverMessageIds: [] }) });
  const original = f.receive(placeholder); await f.channel.whenIdle();
  const record = f.store.data.records[0];
  assert.equal(record.state, 'unknown'); assert.equal(record.unavailableNotice, true); assert.equal(recordState(record), 'unknown');
  assert.equal(record.acknowledgedMessageIds?.length || 0, 0);
  f.channel.receive(original, 'synthetic-owner'); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.calls.length, 0);
  assert.throws(() => recoveryAllowed({}, record, 'regenerate'), { code: 'RECOVERY_NOT_ALLOWED' });
});

test('group notices require native mention of this account, while ordinary group placeholders stay silent', async t => {
  const f = fixture(t), group = { chatType: 'group', peerId: 'synthetic-room@chatroom' };
  f.receive(placeholder, group); await f.channel.whenIdle(); assert.equal(f.sent.length, 0);
  f.receive(placeholder, { ...group, message: [{ type: 'at', data: { qq: 'other-member' } }, { type: 'text', data: { text: placeholder } }] });
  await f.channel.whenIdle(); assert.equal(f.sent.length, 0);
  f.receive(placeholder, { ...group, message: [{ type: 'at', data: { qq: 'synthetic-owner' } }, { type: 'text', data: { text: placeholder } }] });
  await f.channel.whenIdle(); assert.equal(f.sent.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.sent[0].chatType, 'group'); assert.equal(f.sent[0].peerId, group.peerId);
  assert.equal(f.sent[0].message[0].data.text, UNAVAILABLE_MESSAGE_REPLY);
});

for (const mode of ['nickname', 'participate', 'natural']) test(`unreadable group content never guesses a wake name or interrupts ${mode} chat`, async t => {
  const f = fixture(t), room = 'synthetic-room@chatroom';
  f.store.setConversationSettings('synthetic-owner', 'group', room, {
    ...f.store.conversationSettings('synthetic-owner', 'group', room), mode,
  });
  f.receive(placeholder, { chatType: 'group', peerId: room }); await f.channel.whenIdle();
  assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.store.data.records.find(row => row.contentUnavailable).unavailableNotice, undefined);
});

test('disabled, unauthorized, offline and stale messages do not send a notice', async t => {
  const f = fixture(t);
  f.receive(placeholder, { peerId: 'unapproved-peer', sender: { id: 'unapproved-peer' } });
  f.receive(placeholder, { time: Math.floor(Date.now()/1000) - 601 });
  f.status.online = false; f.receive(placeholder); f.status.online = true;
  f.store.configure('synthetic-owner', { ...f.store.settings('synthetic-owner'), enabled: false }); f.receive(placeholder);
  await f.channel.whenIdle(); assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
});

test('revoking authorization while a notice is queued prevents its delivery', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), reached = Promise.withResolvers();
  const base = f.runner.run;
  f.runner.run = async request => { if (request.text === '占用') { reached.resolve(); await gate.promise; } return base(request); };
  f.receive('占用', { peerId: 'busy-friend', sender: { id: 'busy-friend' } }); await reached.promise;
  f.receive(placeholder);
  assert.equal(f.channel.queue.length, 1);
  f.store.configure('synthetic-owner', { ...f.store.settings('synthetic-owner'), privatePeers: ['busy-friend'] });
  gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.sent.filter(item => item.peerId === 'synthetic-friend').length, 0);
  assert.equal(f.store.data.records.find(row => row.unavailableNotice).state, 'cancelled');
});

test('a normally decoded quoted reply still sends its current text to the model', async t => {
  const f = fixture(t);
  f.receive('看得到么', { messageType: 49, partial: false, message: [
    { type: 'reply', data: { id: 'wx:synthetic-friend:9007199254740999', content: '111', senderId: 'synthetic-friend' } },
    { type: 'text', data: { text: '看得到么' } },
  ] });
  await f.channel.whenIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].text, '看得到么'); assert.equal(f.sent.length, 1);
  assert.notEqual(f.sent[0].message[0].data.text, UNAVAILABLE_MESSAGE_REPLY);
});

test('old unavailable records remain missing-content problems, while sent notices keep delivery semantics', () => {
  const old = { key: 'old', accountId: 'owner', state: 'skipped', contentUnavailable: true, reason: '已记录无法解析的消息占位，等待可读的文字要求' };
  assert.equal(recordState(old), 'failed'); assert.equal(old.state, 'skipped'); assert.equal(recordSpec(old).title, UNAVAILABLE_MESSAGE_TITLE);
  assert.equal(recordState({ ...old, unavailableNotice: true, state: 'sending' }), 'running');
  assert.equal(recordState({ ...old, unavailableNotice: true, state: 'sent' }), 'completed');
  assert.equal(recordState({ state: 'skipped', reason: '群消息未 @ 我' }), 'skipped');
});

const root = path.resolve(import.meta.dirname, '..');
const jsxRuntime = `export const Fragment='fragment'; export function jsx(type,props){return {type,props};}export const jsxs=jsx;export function createElement(type,props,...children){return {type,props:{...props,children}};}export default {createElement};`;
const entry = `export {Records} from ${JSON.stringify(path.join(root,'frontend/pages/records/page.jsx'))};`;
const bundle = await rolldown({ input: 'virtual:reception-page', platform: 'node', plugins: [{ name: 'reception-jsx',
  resolveId: id => id === 'virtual:reception-page' ? id : ['react','react/jsx-runtime'].includes(id) ? 'synthetic-react' : null,
  load: id => id === 'virtual:reception-page' ? entry : id === 'synthetic-react' ? jsxRuntime : null }] });
let Records;
try { const { output } = await bundle.generate({ format: 'esm' }); ({ Records } = await import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'))); }
finally { await bundle.close(); }
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : [value, ...nodes(value.props?.children)];
function render(records) { return Records({ rows: [], selected: { peerId: 'synthetic-friend', chatType: 'private', name: '合成会话' }, query: '', type: 'all', data: { records }, processing: {} }); }

test('the real records page distinguishes unread old rows from notices confirmed by WeChat', () => {
  const old = render([{ key: 'old', state: 'skipped', contentUnavailable: true, reason: '已记录无法解析的消息占位，等待可读的文字要求' }]);
  assert.equal(nodes(old).find(node => node.props?.label === '正文未读到').props.state, 'failed');
  assert.equal(nodes(old).find(node => node.props?.['data-testid'] === 'receive-content-unavailable').props.children, UNAVAILABLE_MESSAGE_REASON);
  assert.doesNotMatch(JSON.stringify(old), /未触发回复|等待可读的文字要求/);
  const informed = render([{ key: 'new', state: 'sent', contentUnavailable: true, unavailableNotice: true, reply: UNAVAILABLE_MESSAGE_REPLY }]);
  assert.equal(nodes(informed).find(node => node.props?.label === '已告知读不到').props.state, 'sent');
  assert(JSON.stringify(informed).includes(UNAVAILABLE_MESSAGE_REPLY));
  const unknown = render([{ key: 'unknown', state: 'unknown', contentUnavailable: true, unavailableNotice: true }]);
  assert.doesNotMatch(JSON.stringify(unknown), /已告知读不到|服务端已确认/);
  const failed = render([{ key: 'failed', state: 'failed', contentUnavailable: true, unavailableNotice: true, reason: '网络中断' }]);
  assert(JSON.stringify(failed).includes('网络中断'));
});

test('normal skipped records keep their own question, reason and badge semantics', () => {
  const tree = render([{ key: 'normal', state: 'skipped', question: '普通群聊发言', reason: '群消息未 @ 我' }]);
  assert.equal(nodes(tree).find(node => node.props?.['data-record-key'] === 'normal').props['data-state'], 'skipped');
  assert(JSON.stringify(tree).includes('群消息未 @ 我')); assert.doesNotMatch(JSON.stringify(tree), /正文未读到|receive-content-unavailable/);
});
