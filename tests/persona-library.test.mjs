import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../backend/storage/state-store.mjs';
import { distillCandidates, distillPersona } from '../modules/agent/style-distill.mjs';

function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-library-'));
  t.after(() => {
    const real = fs.realpathSync(directory);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert(path.basename(real).startsWith('persona-library-'));
    fs.rmSync(real, { recursive: true, force: true });
  });
  return directory;
}

test('a legacy single persona appears as one entry until the library is written', t => {
  const directory = root(t), store = new StateStore(directory);
  store.setPersona({ name: '甲', aliases: [], prompt: '甲正文' });
  const view = store.personasView();
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].name, '甲');
  assert.equal(store.persona().prompt, '甲正文');
  // Nothing about the active persona may change just because the list exists.
  assert.equal(store.conversationPersona('any', 'private', 'any').prompt, '甲正文');
});

test('creating, switching and deleting personas keeps one active and survives reload', t => {
  const directory = root(t);
  const store = new StateStore(directory);
  store.setPersona({ name: '甲', aliases: [], prompt: '甲正文' });
  store.configure('a', { ...store.settings('a'), privatePeers: ['source-person'] });
  const provenance = { version: 1, accountId: 'a', personId: 'source-person', epoch: 0, generatedAt: 1,
    sourceScopes: [{ accountId: 'a', chatType: 'private', peerId: 'source-person' }], phrases: [] };
  const created = store.createPersona({ persona: { name: '小胖', aliases: [], prompt: '乙正文' }, name: '乙·提炼', source: 'distilled', provenance });
  assert.equal(created.items.length, 2);
  assert.equal(created.activeId, 'p1');
  assert.equal(store.persona().prompt, '乙正文');

  const reloaded = new StateStore(directory);
  assert.deepEqual(reloaded.personasView().items.map(row => row.name), ['甲', '乙·提炼']);
  assert.equal(reloaded.personasView().activeId, 'p1');
  assert.equal(reloaded.persona().prompt, '乙正文');
  assert.equal(reloaded.personasView().items[1].source, 'distilled');

  reloaded.selectPersona('default');
  assert.equal(reloaded.persona().prompt, '甲正文');
  assert.equal(new StateStore(directory).persona().prompt, '甲正文');

  reloaded.deletePersona('p1');
  assert.equal(reloaded.personasView().items.length, 1);
  assert.throws(() => reloaded.deletePersona('default'), { code: 'PERSONA_REQUIRED' });
  assert.throws(() => reloaded.selectPersona('nope'), { code: 'PERSONA_NOT_FOUND' });
  assert.equal(reloaded.persona().prompt, '甲正文');
});

test('legacy distilled entries remain immediately usable without provenance or forced copying', t => {
  const directory = root(t), store = new StateStore(directory);
  store.setPersona({ name: '甲', aliases: [], prompt: '人工正文' });
  const manual = store.personaEntries()[0];
  store._writePersonas([manual, { id: 'old', name: '旧提炼', source: 'distilled', createdAt: 0,
    persona: { name: '乙', aliases: [], prompt: '无法归属的旧正文' } }], 'old');
  assert.equal(store.personasView().items.length, 2);
  assert.equal(store.personasView().items.find(entry => entry.id === 'old').disabled, undefined);
  assert.equal(store.persona().prompt, '无法归属的旧正文');
  store.selectPersona('old');
  const reloaded = new StateStore(directory);
  assert.equal(reloaded.personaEntries().find(entry => entry.id === 'old').persona.prompt, '无法归属的旧正文');
  assert.equal(reloaded.persona().prompt, '无法归属的旧正文');
  reloaded.selectPersona('default'); assert.equal(reloaded.persona().prompt, '人工正文');
});

test('editing saves into the active entry only', t => {
  const directory = root(t), store = new StateStore(directory);
  store.setPersona({ name: '甲', aliases: [], prompt: '甲正文' });
  store.createPersona({ persona: { name: '乙', aliases: [], prompt: '乙正文' }, name: '乙' });
  store.setPersona({ name: '乙', aliases: [], prompt: '乙改过' });
  const items = store.personasView().items;
  assert.equal(items.length, 2);
  assert.equal(store.persona().prompt, '乙改过');
  store.selectPersona(items[0].id);
  assert.equal(store.persona().prompt, '甲正文', 'the other persona must stay untouched');
});

const people = [
  { senderId: 'p1', senderName: '甲', direction: 'incoming', text: '好', time: 1 },
  { senderId: 'p1', senderName: '甲', direction: 'incoming', text: '行', time: 2 },
  { senderId: 'p1', senderName: '甲', direction: 'incoming', text: '一般般', time: 3 },
  { senderId: 'p2', senderName: '乙', direction: 'incoming', text: '这是一句比较长的说明，用来模拟另一种说话习惯，字数明显更多一些', time: 4 },
  { senderId: 'me', senderName: '自己', direction: 'outgoing', text: '自己说的话不算样本', time: 5 },
];
function memoryFor(rowsByPeer) {
  return { view: peer => ({ entries: rowsByPeer[peer.peerId] ?? [] }) };
}
const fakeStore = peers => ({
  conversations: () => peers,
  data: { authorizationRevocations: [], authorizationEpochs: {} },
  settings: () => ({ enabled: true, groups: peers.filter(p => p.chatType === 'group').map(p => p.peerId),
    privatePeers: peers.filter(p => p.chatType === 'private').map(p => p.peerId) }),
  isGroupMember: () => true, // Synthetic membership is explicit; a group grant alone is not a sender grant.
  persona: () => ({ name: '小胖' }),
});

const rowsFor = (senderId, senderName, count, offset = 0) => Array.from({ length: count }, (_, index) => ({
  senderId, senderName, direction: 'incoming', text: ['好', '行', '一般般'][index % 3], time: offset + index + 1 }));

test('candidates pool the same person across conversations and also allow small samples', () => {
  const peers = [{ accountId: 'a', chatType: 'group', peerId: 'g1', name: '一群' },
    { accountId: 'a', chatType: 'group', peerId: 'g2', name: '二群' }];
  const store = fakeStore(peers);
  const memory = memoryFor({ g1: [...rowsFor('p1', '甲', 12), ...rowsFor('p2', '乙', 4)],
    g2: [...rowsFor('p1', '甲', 12, 100), ...rowsFor('p3', '丙', 2, 100)] });
  const list = distillCandidates({ store, memory, accountId: 'a' });
  const first = list.find(row => row.senderId === 'p1');
  assert.equal(first.count, 24, 'samples from both groups count toward the same person');
  assert.equal(first.chats.length, 2);
  assert(list.some(row => row.senderId === 'p2'));
  assert(list.some(row => row.senderId === 'p3'));
});

test('distillation gives actual samples to the model instead of generating a statistical persona locally', () => {
  const peers = [{ accountId: 'a', chatType: 'private', peerId: 'p1' }];
  const store = fakeStore(peers);
  const thin = memoryFor({ p1: people.filter(row => row.senderId === 'p1') });
  assert.equal(distillPersona({ store, memory: thin, accountId: 'a', senderId: 'p1' }).samples.length, 3);

  const many = { p1: rowsFor('p1', '甲', 40) };
  const draft = distillPersona({ store, memory: memoryFor(many), accountId: 'a', senderId: 'p1' });
  assert.equal(draft.persona.name, '小胖', 'the assistant keeps its own name');
  assert.equal(draft.persona.prompt, '', 'only the model should fill the persona body');
  assert.equal(draft.samples.length, 40, 'real snippets are retained for the model summary');
  assert.equal(draft.sampling.chats, 1);
  assert.equal(draft.draftToken, undefined);
  assert.match(draft.suggestedName, /甲/);
  assert.doesNotMatch(draft.persona.prompt, /一般般/, 'habits are described, not quoted');
});
