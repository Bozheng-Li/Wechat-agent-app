import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../backend/storage/state-store.mjs';
import { WechatChannel } from '../modules/conversation/channel.mjs';
import { ChannelError } from '../shared/contracts.mjs';
import { stickerPng } from './fixtures/stickers.mjs';
import { recordVersion } from '../modules/workbench/helpers.mjs';

const signal = () => new AbortController().signal;
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-split-history-'));
  const scope = { accountId: 'split-owner', chatType: 'private', peerId: 'split-friend' };
  const store = new StateStore(root), sent = [], bubbles = [];
  store.configure(scope.accountId, { enabled: true, groups: [], privatePeers: [scope.peerId], prompt: '' });
  const transport = { status: () => ({ online: true, account: { id: scope.accountId } }), send: async input => {
    sent.push(input);
    const body = input.message.filter(part => part.type !== 'at');
    assert.equal(body.length, 1, 'transport text flattening must not erase SPLIT boundaries');
    bubbles.push(body[0]);
    const id = String(1000 + sent.length), observedAt = Date.now();
    return { delivery: 'server-ack', serverMessageIds: [id], deliveryParts: [{ index: 0, type: body[0].type,
      state: 'acknowledged', serverMessageId: id, observedAt, time: 1700000000 + sent.length,
      ...(body[0].type === 'text' ? { text: body[0].data.text } : {}) }] };
  } };
  const runner = { run: async () => ({ text: '甲<SPLIT>乙' }) };
  const channel = new WechatChannel({ store, runner, transport });
  const send = (text, asset) => channel.submitScheduled({ ...scope, id: 'split-' + store.data.records.length, recordKey: 'split:' + store.data.records.length,
    senderId: scope.accountId, senderName: '管理员', kind: 'message', content: text, targets: [], ...(asset ? { retryAsset: asset } : {}) }, signal());
  const outgoing = () => store.history(scope.accountId, scope.chatType, scope.peerId, 100).filter(row => row.direction === 'outgoing');
  t.after(async () => { await channel.close(); channel.library.close(); const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^wechat-split-history-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { scope, root, store, channel, transport, sent, bubbles, send, outgoing };
}

test('SPLIT + media delivers real mockchannel bubbles, clean per-ACK history and archive restart', async t => {
  const f = fixture(t);
  f.channel.library.import(f.scope.accountId, { name: 'synthetic.png', kind: 'image', data: stickerPng().toString('base64') });
  const asset = f.channel.library.list(f.scope.accountId).items[0];
  const record = await f.send('甲<SPLIT>乙', asset);
  assert.equal(record.state, 'sent'); assert.equal(record.reply, '甲\n乙');
  assert.deepEqual(f.bubbles.map(part => part.type), ['text', 'text', 'image']);
  const rows = f.outgoing(); assert.deepEqual(rows.map(row => row.messageId), ['1001', '1002', '1003']);
  assert.deepEqual(rows.slice(0, 2).map(row => row.text), ['甲', '乙']);
  assert.equal(rows[2].attachments[0].assetId, asset.id); assert.equal(rows[0].time, 1700000001000);
  assert(!JSON.stringify(record.replyPlan).includes('base64'));
  const reopened = new StateStore(f.root); assert.equal(reopened.history(f.scope.accountId, f.scope.chatType, f.scope.peerId, 100).filter(row => row.direction === 'outgoing').length, 3);
});

test('bad media is rejected before the first split text bubble', async t => {
  const f = fixture(t);
  f.channel.library.import(f.scope.accountId, { name: 'synthetic.png', kind: 'image', data: stickerPng().toString('base64') });
  const asset = f.channel.library.list(f.scope.accountId).items[0];
  f.channel.library.prepareSendSegment = async () => ({ type: 'image', data: { base64: 'YmFk', mediaType: 'image/png' } });
  assert.equal((await f.send('甲<SPLIT>乙', asset)).state, 'failed'); assert.equal(f.sent.length, 0); assert.equal(f.outgoing().length, 0);
});

test('partial ACK history records actual text; recovery sends only explicit not-sent and is idempotent', async t => {
  const f = fixture(t), send = f.transport.send;
  f.transport.send = async input => {
    if (f.sent.length === 1) throw new ChannelError('REJECTED', 'synthetic explicit rejection', { delivery: 'rejected' });
    return send(input);
  };
  const record = await f.send('甲<SPLIT>乙<SPLIT>丙');
  assert.equal(record.state, 'partial'); assert.deepEqual(f.outgoing().map(row => row.text), ['甲']);
  assert.deepEqual(record.deliveryParts.map(part => part.state), ['acknowledged', 'not-sent', 'not-sent']);
  f.transport.send = send;
  const wb = f.channel.workbench;
  const draft = await wb.prepare({ ...f.scope, recordKey: record.key, revision: recordVersion(record), mode: 'text' }, signal());
  assert.equal(draft.text, '乙<SPLIT>丙'); assert.deepEqual(draft.partIndexes, [1, 2]);
  const result = await wb.sendDraft({ accountId: f.scope.accountId, draftId: draft.id, confirmSend: true }, signal());
  assert.equal(result.state, 'sent'); assert.deepEqual(f.outgoing().map(row => row.text), ['甲', '乙', '丙']);
  assert.equal((await wb.sendDraft({ accountId: f.scope.accountId, draftId: draft.id, confirmSend: true }, signal())).repeated, true);
  assert.equal(f.sent.length, 3);
  await assert.rejects(wb.sendDraft({ accountId: f.scope.accountId, draftId: (await wb.prepare({ ...f.scope, recordKey: record.key, revision: recordVersion(record), mode: 'text' }, signal())).id, confirmSend: true }, signal()), { code: 'RECOVERY_ALREADY_ATTEMPTED' });
});

test('unknown split bubble is never resent while later explicitly not-sent bubble remains recoverable', async t => {
  const f = fixture(t), send = f.transport.send;
  f.transport.send = async input => {
    if (f.sent.length === 1) throw new ChannelError('SEND_UNKNOWN', 'synthetic lost ACK', { delivery: 'unknown' });
    return send(input);
  };
  const record = await f.send('甲<SPLIT>乙<SPLIT>丙');
  assert.deepEqual(record.deliveryParts.map(part => part.state), ['acknowledged', 'unknown', 'not-sent']);
  const draft = await f.channel.workbench.prepare({ ...f.scope, recordKey: record.key, revision: recordVersion(record), mode: 'text', confirmUnreceived: true }, signal());
  assert.equal(draft.text, '丙'); assert.deepEqual(draft.partIndexes, [2]);
  f.transport.send = send;
  await f.channel.workbench.sendDraft({ accountId: f.scope.accountId, draftId: draft.id, confirmSend: true }, signal());
  assert.deepEqual(f.outgoing().map(row => row.text), ['甲', '丙']);
});

test('partial legacy ACK without body mapping never claims the whole long bubble was received', async t => {
  for (const delivery of ['unknown', 'rejected']) {
    const f = fixture(t);
    f.transport.send = async () => { throw new ChannelError('PARTIAL_PROTOCOL', 'missing per-chunk mapping', {
      delivery, acknowledgedMessageIds: ['partial-wire-chunk'],
    }); };
    const original = '不能猜成整段都送达。'.repeat(300);
    const record = await f.send(original + '<SPLIT>下一条');
    assert.equal(record.state, 'partial');
    assert.deepEqual(record.acknowledgedMessageIds, ['partial-wire-chunk']);
    assert.equal(record.deliveryParts[0].state, 'unknown');
    assert.equal(record.deliveryParts[1].state, 'not-sent');
    assert.equal(f.outgoing().length, 0, 'one ACK may correspond to only a native chunk');
    const draft = await f.channel.workbench.prepare({ ...f.scope, recordKey: record.key, revision: recordVersion(record), mode: 'text' }, signal());
    assert.equal(draft.text, '下一条', 'never retry the possibly received long prefix');
  }
});

test('cancellation after an in-flight ACK keeps it and leaves the next bubble not-sent', async t => {
  const f = fixture(t), send = f.transport.send;
  f.transport.send = async input => { const result = await send(input); f.channel.cancel('synthetic stop', f.scope); return result; };
  const record = await f.send('甲<SPLIT>乙');
  assert.equal(record.state, 'partial'); assert.deepEqual(record.acknowledgedMessageIds, ['1001']);
  assert.deepEqual(record.deliveryParts.map(part => part.state), ['acknowledged', 'not-sent']);
  assert.deepEqual(f.outgoing().map(row => row.text), ['甲']);
});

test('partial text+media can recover the not-sent image independently and then the remaining text', async t => {
  const f = fixture(t), send = f.transport.send;
  f.channel.library.import(f.scope.accountId, { name: 'synthetic.png', kind: 'image', data: stickerPng().toString('base64') });
  const asset = f.channel.library.list(f.scope.accountId).items[0];
  f.transport.send = async input => {
    if (f.sent.length === 1) throw new ChannelError('REJECTED', 'synthetic explicit rejection', { delivery: 'rejected' });
    return send(input);
  };
  const record = await f.send('甲<SPLIT>乙', asset); assert.equal(record.state, 'partial');
  assert.equal(f.outgoing()[0].attachments?.length || 0, 0);
  f.transport.send = send;
  const wb = f.channel.workbench;
  const imageDraft = await wb.prepare({ ...f.scope, recordKey: record.key, revision: recordVersion(record), mode: 'image' }, signal());
  assert.equal(imageDraft.text, ''); assert.deepEqual(imageDraft.partIndexes, [2]);
  await wb.sendDraft({ accountId: f.scope.accountId, draftId: imageDraft.id, confirmSend: true }, signal());
  assert.equal(f.outgoing().length, 2); assert.equal(f.outgoing()[1].attachments[0].assetId, asset.id);
  const textDraft = await wb.prepare({ ...f.scope, recordKey: record.key, revision: recordVersion(record), mode: 'text' }, signal());
  assert.equal(textDraft.text, '乙'); assert.deepEqual(textDraft.partIndexes, [1]);
  await wb.sendDraft({ accountId: f.scope.accountId, draftId: textDraft.id, confirmSend: true }, signal());
  assert.deepEqual(f.bubbles.map(part => part.type), ['text', 'image', 'text']);
});

test('native echo received before ACK is reconciled by server id, not duplicated', async t => {
  const f = fixture(t), send = f.transport.send;
  f.transport.send = async input => {
    const result = await send(input), id = result.serverMessageIds[0];
    f.store.remember('native:' + id, Date.now(), null, { accountId: f.scope.accountId, message: {
      ...f.scope, id: 'native:' + id, serverMessageId: id, time: 1700000001, direction: 'outgoing',
      sender: { id: f.scope.accountId, nickname: 'Native' }, message: input.message } });
    return result;
  };
  const record = await f.send('甲<SPLIT>乙'); assert.equal(record.state, 'sent');
  assert.equal(f.outgoing().length, 2); assert.deepEqual(f.outgoing().map(row => row.text), ['甲', '乙']);
  const memory = f.channel.memory.load(f.scope).entries.filter(row => row.direction === 'outgoing');
  assert.equal(memory.length, 2);
  assert(memory.every(row => row.kind === 'reply' && row.sourceKey === record.key));
});

test('an early media echo is enriched after ACK without renewing retained memory', async t => {
  const f = fixture(t), send = f.transport.send;
  f.channel.library.import(f.scope.accountId, { name: 'synthetic.png', kind: 'image', data: stickerPng().toString('base64') });
  const asset = f.channel.library.list(f.scope.accountId).items[0];
  let rememberedAt;
  f.transport.send = async input => {
    const result = await send(input), id = result.serverMessageIds[0];
    f.store.remember('native:' + id, Date.now(), null, { accountId: f.scope.accountId, message: {
      ...f.scope, id: 'native:' + id, serverMessageId: id, time: 1700000001, direction: 'outgoing',
      sender: { id: f.scope.accountId, nickname: 'Native' }, message: input.message } });
    rememberedAt = f.channel.memory.load(f.scope).entries.find(row => row.messageId === id).rememberedAt;
    return result;
  };
  const record = await f.send('', asset);
  assert.equal(record.state, 'sent');
  const entries = f.channel.memory.load(f.scope).entries.filter(row => row.direction === 'outgoing');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].attachments[0].assetId, asset.id);
  assert.equal(entries[0].rememberedAt, rememberedAt);
  assert.equal(entries[0].kind, 'reply');
});
