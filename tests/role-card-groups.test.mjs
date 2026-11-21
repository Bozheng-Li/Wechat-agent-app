import test from 'node:test';
import assert from 'node:assert/strict';
import { roleCardGroups, rolePersonDisplayName } from '../frontend/pages/memory/role-card-groups.mjs';
import { filledRoleCardFields, roleCardHasData } from '../shared/role-card.mjs';

const people = [
  { personId: 'alice', name: '小宁', filledFields: 1, updatedAt: 300, aliases: [], preview: { preferences: '喜欢红茶' } },
  { personId: 'bob', name: '小宁', filledFields: 3, updatedAt: 100, aliases: [], preview: { background: '学习计算机' } },
  { personId: 'carol', name: '小禾', filledFields: 2, updatedAt: 200, aliases: [], preview: { preferences: '喜欢骑行' } },
  { personId: 'group-only', name: '群友', filledFields: 4, updatedAt: 400, aliases: [], preview: {} },
];
const audience = { source: 'wechat-contacts-live', membershipComplete: true,
  contacts: [{ id: 'alice', labelIds: ['1'] }, { id: 'bob', labelIds: ['1', '2', '1'] }, { id: 'carol', labelIds: [] }],
  labels: [{ id: '1', name: '计实一班' }, { id: '2', name: '摄影朋友' }, { id: '3', name: '空标签' }] };

test('actual contact ids join labels, overlap without merging same names, and untagged people come last', () => {
  const result = roleCardGroups(people, audience);
  assert.deepEqual(result.groups.map(group => [group.name, group.people.map(row => row.personId)]), [
    ['计实一班', ['bob', 'alice']], ['摄影朋友', ['bob']], ['未标签', ['group-only', 'carol']],
  ]);
  assert.equal(result.filtered.length, 4, 'overlapping tags count each person once');
  assert.deepEqual(people.map(row => row.personId), ['alice', 'bob', 'carol', 'group-only'], 'grouping leaves the source rows intact');
});

test('live WeChat name fills an empty card label, while a saved card name remains preferred', () => {
  const rows = [{ personId: 'person-a', name: 'person-a', filledFields: 1, aliases: [], preview: {} },
    { personId: 'person-b', name: '角色卡姓名', filledFields: 1, aliases: [], preview: {} }];
  const snapshot = { ...audience, contacts: [
    { id: 'person-a', name: '备注称呼', nickname: '微信昵称', remark: '备注称呼', labelIds: [] },
    { id: 'person-b', name: '另一个备注', nickname: '另一个昵称', remark: '另一个备注', labelIds: [] },
  ] };
  const result = roleCardGroups(rows, snapshot);
  assert.equal(result.filtered.find(person => person.personId === 'person-a').name, '备注称呼');
  assert.equal(result.filtered.find(person => person.personId === 'person-b').name, '角色卡姓名');
});

test('display names use the same ready live snapshot as label groups', () => {
  const person = { personId: 'alice', name: 'alice', filledFields: 1, aliases: [], preview: {} };
  const live = { ...audience, contacts: [{ id: 'alice', remark: '微信备注', nickname: '微信昵称', labelIds: ['1'] }] };
  assert.equal(rolePersonDisplayName(person, live), '微信备注');
  assert.equal(roleCardGroups([person], live).filtered[0].name, '微信备注');
  for (const snapshot of [null, { ...live, source: 'cache' }, { ...live, membershipComplete: false }, { ...live, labels: undefined }]) {
    assert.equal(rolePersonDisplayName(person, snapshot), 'alice');
    assert.equal(roleCardGroups([person], snapshot).filtered[0].name, 'alice');
  }
  assert.equal(person.name, 'alice', 'display fallback never writes into the saved card');
});

test('tag search retains distinct identities and cards still sort by number of fields', () => {
  assert.deepEqual(roleCardGroups(people, audience, '计实一班').filtered.map(row => row.personId), ['bob', 'alice']);
  assert.deepEqual(roleCardGroups(people, audience, '未标签').filtered.map(row => row.personId), ['group-only', 'carol']);
  assert.deepEqual(roleCardGroups(people, audience, '小宁').filtered.map(row => row.personId), ['bob', 'alice']);
  assert.deepEqual(roleCardGroups(people, audience, '红茶').filtered.map(row => row.personId), ['alice']);
});

test('unread or incomplete labels stay unknown rather than being claimed as untagged', () => {
  for (const snapshot of [null, { ...audience, membershipComplete: false }, { ...audience, source: 'cache' }]) {
    const result = roleCardGroups(people, snapshot);
    assert.deepEqual(result.groups.map(group => group.name), ['标签待读取']);
    assert.equal(roleCardGroups(people, snapshot, '未标签').filtered.length, 0);
  }
});

test('scoped label snapshots do not claim unread or unavailable people have no labels', () => {
  const snapshot = { ...audience, source: 'wechat-role-labels-live' };
  const groups = roleCardGroups(people, snapshot).groups;
  assert.deepEqual(groups.map(group => [group.name, group.people.map(row => row.personId)]), [
    ['计实一班', ['bob', 'alice']], ['摄影朋友', ['bob']], ['未标签', ['carol']], ['标签待读取', ['group-only']],
  ]);
  assert.deepEqual(roleCardGroups(people, snapshot, '未标签').filtered.map(row => row.personId), ['carol']);
});

test('names and conflicting fields do not establish a card or inflate its usable detail count', () => {
  const card = { label: '小宁', addressAs: '  ', preferences: '喜欢红茶' }, conflicts = [{ field: 'preferences' }];
  assert.equal(roleCardHasData(card, conflicts), false);
  assert.deepEqual(filledRoleCardFields(card, conflicts), ['label']);
  assert.equal(roleCardHasData(card), true);
  assert.deepEqual(filledRoleCardFields(card), ['label', 'preferences']);
});
