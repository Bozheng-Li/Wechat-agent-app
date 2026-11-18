import test from 'node:test';
import assert from 'node:assert/strict';
// Deliberately import live source: these regressions must not pass against stale lib.
import { projectMemory, resolveTargets, recentRoleHistory } from '../modules/memory/roles/retrieval.mjs';
import { roleMemoryData } from '../modules/memory/roles/context.mjs';
import { personRoleContext, personRoleCardTool, readableRoleCard } from '../modules/memory/roles/tool.mjs';
import { emptyRoleCard } from '../shared/role-card.mjs';

const now = Date.parse('2026-11-18T09:00:00Z');
const scope = { accountId: 'synthetic-owner', chatType: 'group', peerId: 'synthetic@chatroom', key: 'scope' };
const people = ['本人', '小陈', '小博'].map((name, index) => ({ accountId: scope.accountId, id: ['alice', 'chen', 'bo'][index], name, aliases: [] }));
const data = extra => ({ scope, now, query: '', people, speaker: people[0], history: [], persona: {}, facts: [], ...extra });
const history = (text, direction = 'incoming', time = now - 1000, extra = {}) => ({ text, direction, time,
  senderId: direction === 'incoming' ? 'alice' : scope.accountId, ...extra });
const fact = (id, text, subjectId = 'alice', extra = {}) => ({ id, text, subjectId, scope, state: 'active', createdAt: now - 10000,
  sources: [{ senderId: subjectId, time: now - 20000, quote: text }], ...extra });

for (const query of ['我还有其他忌口吗', '我买吉他有什么偏好', '其他人有什么忌口', '利他行为是什么意思', '他乡买吉他']) {
  test('word-internal 他 does not become a person reference: ' + query, () => {
    const result = resolveTargets(data({ query }));
    assert.deepEqual(result.targets, ['alice']);
    assert.equal(result.unresolvedReference, false);
  });
}
test('其他 keeps the speaker food fact and 吉他 recalls interests rather than coffee', () => {
  const facts = [fact('food', '我不吃香菜'), fact('guitar', '我喜欢古典吉他'), fact('coffee', '我只喝美式咖啡')];
  assert(projectMemory(data({ query: '我还有其他忌口吗', facts })).selectedIds.includes('food'));
  const result = projectMemory(data({ query: '我买吉他有什么偏好', facts }));
  assert(result.selectedIds.includes('guitar'));
  assert(!result.selectedIds.includes('coffee'));
});
for (const query of ['他吃什么要注意', '那她呢', '我和他各有什么忌口', '给她点餐', '其他人先等下，他呢']) {
  test('real pronouns retain grammatical boundaries: ' + query, () => {
    const result = resolveTargets(data({ query, history: [history('先说小博吧', 'outgoing')] }));
    assert(result.targets.includes('bo'));
    assert.equal(result.unresolvedReference, false);
  });
}
test('a newer outgoing topic wins over the old incoming name and preserves fact provenance', () => {
  const facts = [fact('chen-food', '我不吃香菜', 'chen'), fact('bo-food', '我不吃花生', 'bo')];
  const value = data({ query: '他吃什么要注意', facts,
    history: [history('小陈的忌口呢', 'incoming', now - 3000), history('先说小博吧', 'outgoing', now - 2000)] });
  const before = structuredClone(value);
  assert.deepEqual(resolveTargets(value).targets, ['bo']);
  const result = projectMemory(value);
  assert(result.selectedIds.includes('bo-food')); assert(!result.selectedIds.includes('chen-food'));
  assert(result.memory.includes('不是个人事实证据'));
  assert.deepEqual(value, before, 'topic resolution must never create/confirm facts');
});
test('explicit order wins over array order and sender clock drift', () => {
  const old = history('小陈', 'incoming', now - 1000, { order: 1 });
  const newer = history('先说小博吧', 'outgoing', now - 3000, { order: 2 });
  const value = data({ query: '他吃什么要注意', history: [newer, old] });
  assert.deepEqual(recentRoleHistory(value), [old, newer]);
  assert.deepEqual(resolveTargets(value).targets, ['bo']);
});
test('incoming names older than three quiet incoming rows can still resolve a near-turn reference', () => {
  const rows = [history('小博', 'incoming', now - 6000), ...Array.from({ length: 4 }, (_, index) => history('收到', 'incoming', now - 5000 + index * 1000))];
  assert.deepEqual(resolveTargets(data({ query: '他吃什么要注意', history: rows })).targets, ['bo']);
});
for (const rows of [
  [history('小陈和小博各自吃什么', 'outgoing')],
  [history('小陈', 'incoming', now - 3000), history('我猜她可能指小博', 'outgoing')],
  [history('小陈', 'incoming', now - 3000), history('换个话题，计算一加一', 'outgoing')],
  [history('先说小博吧', 'outgoing', now + 1000)],
  [history('先说小博吧', 'outgoing', now - 3600000)],
  [history('“小博”是例句里的名字', 'outgoing')],
  [history('小博', 'incoming', now - 1000, { accountId: 'foreign-owner' })],
  [{ text: '小博', direction: 'outgoing', time: 'invalid' }],
]) {
  test('ambiguous, guessed, unrelated, future, stale or foreign references stay unresolved: ' + JSON.stringify(rows), () => {
    const result = resolveTargets(data({ query: '他吃什么要注意', history: rows }));
    assert.deepEqual(result.targets, []); assert.equal(result.unresolvedReference, true);
  });
}
for (const bridge of ['嗯', '[表情消息]', '👍']) {
  test('quiet and nonverbal replies do not erase a grounded near-turn topic: ' + bridge, () => {
    const rows = [history('先说小博吧，他喝咖啡', 'outgoing', now - 2000), history(bridge)];
    assert.deepEqual(resolveTargets(data({ query: '他吃什么要注意', history: rows })).targets, ['bo']);
    assert(projectMemory(data({ query: '那我呢', history: rows, facts: [fact('coffee', '我只喝美式咖啡')] })).selectedIds.includes('coffee'));
  });
}
test('an explicit topic switch can select one person within a multi-person message', () => {
  assert.deepEqual(resolveTargets(data({ query: '他呢', history: [history('先说小博吧，小陈等下再说', 'outgoing')] })).targets, ['bo']);
});
test('那我呢 inherits only the recent coffee topic and keeps the current person', () => {
  const facts = [fact('alice-coffee', '我只喝美式咖啡'), fact('alice-work', '我工作回复先给结论'), fact('bo-coffee', '我喜欢拿铁', 'bo')];
  const result = projectMemory(data({ query: '那我呢', facts,
    history: [history('小博喝哪种咖啡', 'incoming', now - 2000), history('小博的咖啡喜欢拿铁', 'outgoing')] }));
  assert.deepEqual(result.targets, ['alice']); assert(result.selectedIds.includes('alice-coffee'));
  assert(!result.selectedIds.includes('alice-work')); assert(!result.selectedIds.includes('bo-coffee'));
  assert.deepEqual(result.index, ['饮品']);
});
for (const query of ['帮我写工作汇报', '我买吉他有什么偏好', '太阳有多大', '早安', '另外问，我呢']) {
  test('a complete new question never inherits an old coffee topic: ' + query, () => {
    const result = projectMemory(data({ query, facts: [fact('coffee', '我只喝美式咖啡')], history: [history('小博喜欢咖啡', 'outgoing')] }));
    assert(!result.selectedIds.includes('coffee'));
  });
}
test('unrelated topicless turns and receive-time boundaries stop topic inheritance', () => {
  const facts = [fact('coffee', '我只喝美式咖啡')];
  assert(!projectMemory(data({ query: '那我呢', facts, history: [history('咖啡', 'incoming', now - 3000), history('换个话题，计算一加一', 'outgoing')] })).selectedIds.length);
  assert(!projectMemory(data({ query: '那我呢', facts, history: [history('咖啡', 'outgoing', now + 1000)] })).selectedIds.length);
});
test('roleMemoryData carries the receive cutoff rather than the later worker clock into retrieval', () => {
  const cutoff = now - 2000;
  const memory = { selector: () => scope, now: () => now, store: { conversations: () => [], conversationPersona: () => ({}) } };
  const document = { sections: [{ key: scope.key, facts: [] }], globalNotes: '' };
  const value = roleMemoryData(memory, { senderId: 'alice', senderName: '本人' }, { document, beforeTime: cutoff,
    text: '那我呢', history: [history('咖啡', 'outgoing', now - 1000)] });
  assert.equal(value.beforeTime, cutoff); assert.deepEqual(recentRoleHistory(value), []);
});

test('unconfirmed ASCII initials do not become the speaker or an invented person alias', () => {
  const members = [{ ...people[0], name: '郑一亮', aliases: [] }, { ...people[2], name: '张依琳', aliases: [] }];
  for (const query of ['zyl', 'zyl呢', 'zyl吃什么要注意']) {
    const value = data({ people: members, query, facts: [fact('self-food', '我不吃香菜')] });
    const result = resolveTargets(value);
    assert.deepEqual(result.targets, []); assert.equal(result.unresolvedIdentifier, 'zyl');
    assert.deepEqual(projectMemory(value).selectedIds, []);
    assert(!members.some(person => person.aliases.includes('zyl')));
  }
});
test('only explicitly observed ASCII names/aliases match, with whole-token boundaries', () => {
  const members = [{ ...people[0], name: '郑一亮', aliases: [] }, { ...people[2], name: '张依琳', aliases: ['zyl'] }];
  assert.deepEqual(resolveTargets(data({ people: members, query: 'ZYL呢' })).targets, ['bo']);
  assert.deepEqual(resolveTargets(data({ people: members, query: 'zyl吃什么' })).targets, ['bo']);
  assert.deepEqual(resolveTargets(data({ people: members, query: 'xzyl吃什么' })).targets, []);
  assert.deepEqual(resolveTargets(data({ people: members, query: 'zylx吃什么' })).targets, []);
});
test('ASCII alias case handling also preserves negation, topic switches and continuation grammar', () => {
  const members = [{ ...people[0] }, { ...people[2], aliases: ['zyl'] }];
  assert(!resolveTargets(data({ people: members, query: '不要给ZYL，给我' })).targets.includes('bo'));
  const rows = [history('先说ZYL吧，小陈等下', 'outgoing')];
  assert.deepEqual(resolveTargets(data({ people: [...members, people[1]], query: '他呢', history: rows })).targets, ['bo']);
  const result = projectMemory(data({ people: members, query: 'ZYL呢', history: [history('咖啡喝什么', 'outgoing')], facts: [fact('bo-coffee', '我只喝美式咖啡', 'bo')] }));
  assert(result.selectedIds.includes('bo-coffee'));
});
test('ASCII aliases that differ only by case remain an explicit multi-person ambiguity', () => {
  const members = [{ ...people[0], aliases: ['ZYL'] }, { ...people[2], aliases: ['zyl'] }];
  const result = resolveTargets(data({ people: members, query: 'Zyl呢' }));
  assert.deepEqual(new Set(result.targets), new Set(['alice', 'bo'])); assert(result.ambiguousNames.includes('zyl'));
});
test('same-group nicknames from every sender resolve by stable IDs, not only the primary speaker', () => {
  const memory = { selector: () => scope, now: () => now, store: { conversations: () => [], conversationPersona: () => ({}) } };
  const document = { sections: [{ key: scope.key, facts: [] }], globalNotes: '' };
  const rows = [history('普通消息', 'incoming', now - 10000, { senderId: 'bo', senderName: 'zyl' }),
    history('普通消息', 'incoming', now - 1000, { senderId: 'alice', senderName: '郑一亮' }),
    history('普通消息', 'incoming', now - 500, { senderId: 'foreign', senderName: 'zyl', peerId: 'foreign@chatroom' })];
  const value = roleMemoryData(memory, { senderId: 'alice', senderName: '郑一亮' }, { document, text: 'zyl呢', history: rows });
  assert.deepEqual(resolveTargets(value).targets, ['bo']);
  assert.equal(value.speaker.id, 'alice'); assert(!value.people.some(person => person.id === 'foreign'));
  const sameName = { ...value, people: [...value.people, { accountId: scope.accountId, id: 'other', name: '另一位', aliases: ['zyl'] }] };
  const result = resolveTargets(sameName);
  assert.deepEqual(new Set(result.targets), new Set(['bo', 'other']));
  assert(result.ambiguousNames.includes('zyl'));
});

const ownerEvidence = at => ({ origin: 'owner', updatedAt: at, sources: [] });
const agentEvidence = (value, at) => ({ origin: 'agent', updatedAt: at + 100, sourceAt: at,
  sources: [{ senderId: 'alice', time: at, quote: '叫我' + value, chatType: 'private', peerId: 'alice' }] });
const view = extra => ({ scope: { accountId: scope.accountId, personId: 'alice' }, personId: 'alice', roleId: 'synthetic-role',
  card: { ...emptyRoleCard(), addressAs: '新称呼' }, aliases: ['本人'], evidence: { addressAs: agentEvidence('新称呼', now + 1000) },
  conflicts: [], changes: [], revision: 'synthetic-revision', updatedAt: now + 1100, reviewedAt: now + 1100, pendingCount: 0, ...extra });
const change = (before, after, at, beforeEvidence, beforeConflicts = []) => ({ field: 'addressAs', before, after, at,
  origin: 'agent', beforeEvidence, beforeConflicts });

test('future field overwrites replay the receive-time value with its original evidence', () => {
  const prior = agentEvidence('旧称呼', now - 1000);
  const current = view({ changes: [change('旧称呼', '新称呼', now + 1100, prior)] });
  const before = structuredClone(current), result = readableRoleCard(current, now);
  assert.equal(result.card.addressAs, '旧称呼'); assert.deepEqual(result.evidence.addressAs, prior);
  assert(!JSON.stringify(result.evidence).includes('叫我新称呼'));
  assert.deepEqual(current, before, 'read projection must not mutate storage');
});
test('multiple future revisions replay in reverse order, including unchanged values with changed evidence', () => {
  const oldest = ownerEvidence(now - 1000), middle = agentEvidence('中称呼', now + 1000);
  const current = view({ changes: [change('旧称呼', '中称呼', now + 1100, oldest),
    change('中称呼', '新称呼', now + 2100, middle), change('新称呼', '新称呼', now + 3100, agentEvidence('新称呼', now + 2000))] });
  assert.equal(readableRoleCard(current, now).card.addressAs, '旧称呼');
  assert.deepEqual(readableRoleCard(current, now).evidence.addressAs, oldest);
});
test('a conflict that a future update resolves still suppresses the receive-time value', () => {
  const conflict = { field: 'addressAs', note: '称呼待确定', at: now - 500, evidence: [] };
  const current = view({ changes: [change('旧称呼', '新称呼', now + 1100, ownerEvidence(now - 1000), [conflict])] });
  const result = readableRoleCard(current, now);
  assert.equal(result.card.addressAs, ''); assert.deepEqual(result.conflicts, [conflict]);
});
test('a conflict created after reception does not hide a previously valid unchanged value', () => {
  const current = view({ evidence: { addressAs: ownerEvidence(now - 1000) }, updatedAt: now - 1000,
    conflicts: [{ field: 'addressAs', note: '未来冲突', at: now + 1000 }] });
  assert.equal(readableRoleCard(current, now).card.addressAs, '新称呼');
});
for (const current of [
  view({ card: emptyRoleCard(), changes: [change('旧称呼', '', now + 1000, ownerEvidence(now - 1000))] }),
  view({ changes: [change('旧称呼', '', now + 100, ownerEvidence(now - 1000)), change('', '新称呼', now + 1100, ownerEvidence(now + 100))] }),
  view({ tombstone: true, changes: [change('旧称呼', '新称呼', now + 1100, ownerEvidence(now - 1000))] }),
  view({ revokedAt: now + 1000, changes: [change('旧称呼', '新称呼', now + 1100, ownerEvidence(now - 1000))] }),
  view({ changes: [{ field: 'addressAs', before: '旧称呼', after: '新称呼', at: now + 1100, origin: 'agent' }] }),
  view({ changes: [change('旧称呼', '不匹配值', now + 1100, ownerEvidence(now - 1000))] }),
  view({ changes: [change('旧称呼', '新称呼', now + 1100, agentEvidence('旧称呼', now + 500))] }),
  view({ changes: [change('旧称呼', '新称呼', now + 1100, { ...ownerEvidence(now - 1000), sources: [{ senderId: 'foreign-person' }] })] }),
]) {
  test('deletion, tombstone, revocation, incomplete history or invalid evidence cannot resurrect a field: ' + JSON.stringify(current.changes), () => {
    assert.equal(readableRoleCard(current, now).card.addressAs, '');
  });
}
test('empty conflicted cards still expose the conflict without reviving a value', () => {
  const conflict = { field: 'addressAs', note: '没有确定称呼', at: now - 1000 };
  const result = readableRoleCard(view({ card: emptyRoleCard(), conflicts: [conflict] }), now);
  assert.equal(result.found, false); assert.deepEqual(result.conflicts, [conflict]);
});
test('future quotations cannot hide behind an older evidence timestamp', () => {
  const prior = { ...ownerEvidence(now - 1000), sources: [{ senderId: 'alice', time: now + 1000, quote: '未来引文' }] };
  const result = readableRoleCard(view({ changes: [change('旧称呼', '新称呼', now + 1100, prior)] }), now);
  assert.equal(result.card.addressAs, ''); assert.deepEqual(result.evidence, {});
});
test('role-card scope is preserved during historical replay', () => {
  assert.throws(() => readableRoleCard(view({ scope: { ...scope, personId: 'other' } }), now), { code: 'ROLE_CARD_SCOPE' });
});

function channelWith(views) {
  const authorized = new Set(views.map(row => row.personId));
  const store = { data: {}, settings: () => ({ enabled: true, privatePeers: [...authorized], groups: [scope.peerId] }),
    roleCards: { list: () => views, view: target => views.find(row => row.personId === target.personId), errors: new Map() } };
  return { store, authorized };
}
test('the fifth-listed primary speaker appears first before the four-person index limit', () => {
  const ids = ['one', 'two', 'three', 'four', 'alice'];
  const views = ids.map(personId => view({ scope: { accountId: scope.accountId, personId }, personId,
    aliases: [personId], card: { ...emptyRoleCard(), label: personId, addressAs: personId }, evidence: { addressAs: ownerEvidence(now - 1000) }, updatedAt: now - 1000 }));
  const channel = channelWith(views);
  const context = personRoleContext(channel, { ...scope, senderId: 'alice', requestedAt: now }, { text: 'one two three four', onDemand: true, maxChars: 1400 });
  const rows = context.split('\n').slice(1).map(line => JSON.parse(line));
  assert.equal(rows[0].personId, 'alice'); assert.equal(rows.length, 4);
});
test('long conflict notes do not evict the primary speaker under the index budget', () => {
  const current = view({ evidence: { addressAs: ownerEvidence(now - 1000) },
    conflicts: Object.keys(emptyRoleCard()).map(field => ({ field, note: '冲突说明'.repeat(70), at: now - 1000 })) });
  const channel = channelWith([current]);
  const context = personRoleContext(channel, { ...scope, senderId: 'alice', requestedAt: now }, { onDemand: true, maxChars: 1100 });
  const row = JSON.parse(context.split('\n')[1]);
  assert.equal(row.personId, 'alice'); assert(row.conflicts.some(conflict => conflict.field === 'addressAs'));
  assert(context.length <= 1100);
});
test('tool reads and automatic context use the same receive-time card projection and current authorization', async () => {
  const current = view({ changes: [change('旧称呼', '新称呼', now + 1100, ownerEvidence(now - 1000))] });
  const channel = channelWith([current]);
  const bounded = { ...scope, senderId: 'alice', requestedAt: now };
  assert(personRoleContext(channel, bounded).includes('旧称呼'));
  const tool = personRoleCardTool(channel, bounded);
  const result = JSON.parse(await tool.execute({ action: 'read', includeEvidence: true }));
  assert.equal(result.card.addressAs, '旧称呼'); assert(!JSON.stringify(result.evidence).includes('新称呼'));
  channel.authorized.delete('alice');
  await assert.rejects(tool.execute({ action: 'read' }), { code: 'ROLE_CARD_PERSON_UNKNOWN' });
});
