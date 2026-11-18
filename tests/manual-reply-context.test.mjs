import test from 'node:test';
import assert from 'node:assert/strict';
import { observeManualReply } from '../modules/conversation/incoming.mjs';

function fixture({ mode = 'default', authorized = true, enabled = true } = {}) {
  const saved = [], paused = [];
  const store = {
    data: { records: [], seen: {}, authorizationRevocations: [], authorizationEpochs: {} },
    settings: () => ({ enabled, privatePeers: authorized ? ['friend'] : [], groups: authorized ? ['room@chatroom'] : [] }),
    conversationSettings: () => ({ mode }),
    remember(key, at, _record, observation) { this.data.seen[key] = at; saved.push(observation); },
  };
  const channel = { store, now: () => 1800000000000, transport: { status: () => ({ online: true, account: { id: 'owner' } }) },
    natural: { onManual: () => ({ pendingKey: 'old' }) },
    cancelNaturalAmbient: (...args) => paused.push(args), fail: error => { throw error; } };
  const message = (chatType = 'private', text = '先说小博') => ({ id: 'm1', serverMessageId: '101', direction: 'outgoing',
    sender: { id: 'owner' }, chatType, peerId: chatType === 'group' ? 'room@chatroom' : 'friend',
    time: channel.now() / 1000, source: 'longlink:NewSync', message: [{ type: 'text', data: { text } }] });
  return { channel, store, saved, paused, message };
}

test('manual private and ordinary-group replies are retained as dialogue without natural side effects', () => {
  for (const chatType of ['private', 'group']) {
    const f = fixture();
    observeManualReply(f.channel, f.message(chatType), 'owner');
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].message.direction, 'outgoing');
    assert.equal(f.saved[0].natural, undefined);
    assert.equal(f.paused.length, 0);
    observeManualReply(f.channel, f.message(chatType), 'owner');
    assert.equal(f.saved.length, 1, 'same observation is not saved twice');
  }
});

test('manual natural-group reply still pauses ambient participation', () => {
  const f = fixture({ mode: 'natural' });
  observeManualReply(f.channel, f.message('group'), 'owner');
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].natural.pendingKey, null);
  assert.equal(f.paused.length, 1);
});

test('known Agent receipts and local transport ACK echoes never become manual replies', () => {
  for (const source of ['longlink:SendMsg', 'longlink:UploadMsgImg', 'shortlink:SendEmoji', 'shortlink:SendAppMsg']) {
    const f = fixture({ mode: 'natural' });
    observeManualReply(f.channel, { ...f.message('group'), source, delivery: 'server-ack' }, 'owner');
    assert.equal(f.saved.length, 0);
    assert.equal(f.paused.length, 0);
  }
  const f = fixture();
  f.store.data.records.push({ accountId: 'owner', chatType: 'private', peerId: 'friend', acknowledgedMessageIds: ['101'] });
  observeManualReply(f.channel, f.message(), 'owner');
  assert.equal(f.saved.length, 0);
});

test('unauthorized, disabled, foreign-account or stale messages stay out of manual history', () => {
  for (const options of [{ authorized: false }, { enabled: false }]) {
    const f = fixture(options); observeManualReply(f.channel, f.message(), 'owner'); assert.equal(f.saved.length, 0);
  }
  const f = fixture();
  observeManualReply(f.channel, { ...f.message(), sender: { id: 'foreign' } }, 'owner');
  observeManualReply(f.channel, { ...f.message(), time: f.channel.now() / 1000 - 601 }, 'owner');
  assert.equal(f.saved.length, 0);
});
