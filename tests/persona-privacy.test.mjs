import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../backend/storage/state-store.mjs';
import { createPluginService } from '../backend/app/service.mjs';
import { agentMutation } from '../modules/agent/actions.mjs';
import { validatePersonaEntry, validatePersonaProvenance } from '../shared/contracts.mjs';
import { styleProfile } from '../modules/agent/style-profile.mjs';
import { assistantTask, styleSamples, styleSampleEvidence, recurringStylePhrases, styleSummaryMessages,
  assertStylePrivacy, summarizeStyle, statisticalStyleFallback } from '../modules/agent/style-summary.mjs';
import { distillCandidates, distillPersona, issuePersonaDraft, savePersonaDraft } from '../modules/agent/style-distill.mjs';

const persona = (prompt = '说话简短，句尾不用句号。') => ({ name: '助手', aliases: [], prompt });
const source = (overrides = {}) => ({ version: 1, accountId: 'account-a', personId: 'person-a', epoch: 0,
  generatedAt: 100, sourceScopes: [{ accountId: 'account-a', chatType: 'group', peerId: 'room@chatroom' }],
  phrases: ['有一说一', '好的'], ...overrides });
const scope = { accountId: 'account-a', chatType: 'group', peerId: 'room@chatroom' };
const rows = (count = 40, senderId = 'person-a') => Array.from({ length: count }, (_, index) => ({
  direction: 'incoming', senderId, senderName: '合成甲', text: index % 2 ? '有一说一，句子可以再短点' : '好的',
  time: 1000 + index * 1000, chatType: 'group',
}));
function fakeStore() {
  const data = { authorizationRevocations: [], authorizationEpochs: {}, groupMemberExclusions: {} };
  const settings = { privatePeers: ['person-a', 'person-b'], groups: ['room@chatroom'], enabled: true };
  return { data, settings: () => settings, isGroupMember: () => true,
    conversations: () => [scope], persona: () => persona(), settingsValue: settings };
}
function realStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-privacy-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('persona-privacy-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const store = new StateStore(root);
  store.configure('account-a', { ...store.settings('account-a'), privatePeers: ['person-a', 'person-b'], groups: ['room@chatroom'], enabled: true });
  return { root, store };
}
function issue(store, provenance = source(), now = Date.now()) {
  return { accountId: provenance.accountId, senderId: provenance.personId,
    ...issuePersonaDraft(store, provenance, now), persona: persona(), name: '表达方式·合成样本' };
}
const structured = (text = '说话简短，句尾常用语气词。', phrases = ['有一说一']) => JSON.stringify({
  sections: [{ heading: '语气与用词', observations: [{ text, evidence: [0, 1] }] }], phrases,
});
const modelInput = () => {
  const sampleRows = rows();
  return { ctx: {}, selection: {}, profile: styleProfile(sampleRows), samples: styleSamples(sampleRows) };
};

test('automatic output rejects salary, identity, family, contact and unrelated facts', () => {
  for (const text of ['你的工资12000元，说话简短。', '你是项目经理，说话简短。', '你老婆在医院，语气放轻。',
    '说话时用电话13800138000。', '语气词用邮箱hello@example.test。', '你住在杭州，说话简短。',
    '说话表现得内向。', '你爱吃红烧肉。', 'salary is 12000, use short sentences']) {
    assert.throws(() => assertStylePrivacy(text), { code: 'PERSONA_PRIVACY_REJECTED' }, text);
  }
});

test('statistics and dynamically recurring 2–10 character catchphrases remain allowed', () => {
  assert.equal(assertStylePrivacy('说话中位7字，问号20%。\n- 「有一说一」', { phrases: ['有一说一'] }),
    '说话中位7字,问号20%。\n- 「有一说一」');
  const samples = styleSamples(rows());
  assert(recurringStylePhrases(samples).includes('有一说一'));
  assert(!recurringStylePhrases(samples).includes('有一说一，句子可以再短点'));
});

test('sensitive turns are removed while anonymized latest real language reaches one model call', async () => {
  const inputs = [...rows(), { text: '我的工资12000元', time: 999999, chatType: 'private' },
    { text: '我老婆生病住院', time: 999998, chatType: 'private' },
    { text: '请联系hello@example.test', time: 999997, chatType: 'private' },
    { text: '合成甲，这句话有点绕啊', time: 999996, chatType: 'group' }];
  const { samples, sampling } = styleSampleEvidence(inputs, { entities: ['合成甲'] });
  const input = { ctx: {}, selection: {}, profile: styleProfile(inputs), samples, sampling };
  let calls = 0;
  const result = await summarizeStyle({ ...input, client: { complete: async request => {
    calls++;
    const body = request.messages[1].content;
    assert.doesNotMatch(body, /工资|老婆|hello@example|合成甲/);
    assert(samples.every(row => !row.text.includes('12000')), 'numeric timestamps are not leaked salaries');
    assert.match(body, /这句话有点绕啊/);
    assert.match(body, /chatType|group|999996/);
    return { finishReason: 'stop', message: { content: structured() } };
  } } });
  assert.equal(calls, 1);
  assert.match(result.text, /有一说一/);
  assert.equal(sampling.excluded, 3);
});

test('model output requires structured evidence and rejects sensitive facts or long copying', async () => {
  const run = content => summarizeStyle({ ...modelInput(), client: { complete: async () => ({ finishReason: 'stop', message: { content } }) } });
  await assert.rejects(run(structured('说话时提及工资12000元。')), { code: 'PERSONA_PRIVACY_REJECTED' });
  await assert.rejects(run('随意写的档案'), { code: 'PERSONA_SUMMARY_SCHEMA' });
  await assert.rejects(run(structured('私聊中说话常常很短。')), { code: 'PERSONA_SUMMARY_SCHEMA' });
  assert.throws(() => assertStylePrivacy('说话时总是喜欢先说一句今天这个事情真是有点离谱了吧。',
    { samples: [{ text: '今天这个事情真是有点离谱了吧' }] }), { code: 'PERSONA_PRIVACY_REJECTED' });
  assert.throws(() => assertStylePrivacy('合成甲说话很短。', { entities: ['合成甲'] }), { code: 'PERSONA_PRIVACY_REJECTED' });
});

test('samples use latest timestamps, retain chat type and disclose truncation/unknown situations', () => {
  const { samples, sampling } = styleSampleEvidence(rows(300));
  assert.equal(samples.length, 220);
  assert.equal(samples[0].time, 300000);
  assert.equal(samples.at(-1).time, 81000);
  assert.equal(samples[0].chatType, 'group');
  assert.equal(sampling.omitted, 80);
  const unknown = styleSamples([{ text: '有一说一' }, { text: '有一说一' }]);
  assert.equal(unknown[0].chatType, 'unknown');
  const body = styleSummaryMessages({ profile: styleProfile(rows()), samples: unknown })[1].content;
  assert.match(body, /其他场合未知/);
  const fallback = statisticalStyleFallback(styleProfile(rows()));
  assert.match(fallback, /场合.*未知/);
  assert.doesNotMatch(fallback, /年龄|职业|性格|熟人|被夸/);
  assert.doesNotThrow(() => assertStylePrivacy(fallback));
});

test('assistant task filtering needs explicit address plus a task, not a substring or every mention', () => {
  assert.equal(assistantTask('小胖，帮我总结一下这个方案', ['小胖']), true);
  assert.equal(assistantTask('这句话里提到了小胖', ['小胖']), false);
  assert.equal(assistantTask('@某甲 你看着办', ['小胖']), false);
  assert.equal(assistantTask('小胖，早上好', ['小胖']), false);
  const samples = styleSamples([{ text: '@某甲 你看着办' }, { text: '小胖，早上好' },
    { text: '这句话里提到了小胖' }, { text: '小胖，帮我总结一下这个方案' }], { exclude: ['小胖'] });
  assert.equal(samples.length, 3);
  assert(samples.some(row => row.text === '[称呼] 你看着办'));
});

test('candidates and distillation exclude explicitly blocked senders even within granted groups', () => {
  const store = fakeStore();
  store.data.groupMemberExclusions['account-a'] = { excludedPersonIds: ['person-b'] };
  const memory = { view: () => ({ entries: [...rows(30), ...rows(30, 'person-b')] }) };
  assert.deepEqual(distillCandidates({ store, memory, accountId: 'account-a' }).map(row => row.senderId), ['person-a']);
  assert.throws(() => distillPersona({ store, memory, accountId: 'account-a', senderId: 'person-b' }), { code: 'PERSONA_SOURCE_REVOKED' });
  const draft = distillPersona({ store, memory, accountId: 'account-a', senderId: 'person-a' });
  assert.equal(draft.samples[0].chatType, 'group');
  assert.equal(draft.samples[0].time, 30000);
  assert.equal(draft.provenance.sourceScopes.length, 1);
});

test('draft tokens bind account/person/epoch and expire, and failed validation does not consume them', () => {
  const store = fakeStore(), payload = issue(store, source(), 1000);
  let saves = 0;
  const save = () => { saves++; return 'saved'; };
  assert.throws(() => savePersonaDraft(store, { ...payload, accountId: 'other' }, save, 1001), { code: 'PERSONA_DRAFT_MISMATCH' });
  assert.throws(() => savePersonaDraft(store, { ...payload, senderId: 'person-b' }, save, 1001), { code: 'PERSONA_DRAFT_MISMATCH' });
  assert.throws(() => savePersonaDraft(store, { ...payload, persona: persona('工资12000元，说话简短。') }, save, 1001), { code: 'PERSONA_PRIVACY_REJECTED' });
  assert.equal(savePersonaDraft(store, payload, save, 1001), 'saved');
  assert.equal(saves, 1);
  assert.throws(() => savePersonaDraft(store, payload, save, 1002), { code: 'PERSONA_DRAFT_EXPIRED' });
  const expiring = issue(store, source(), 1000);
  assert.throws(() => savePersonaDraft(store, expiring, save, 1000 + 15 * 60000), { code: 'PERSONA_DRAFT_EXPIRED' });
  const epoch = issue(store);
  store.data.authorizationEpochs['account-a'] = 1;
  assert.throws(() => savePersonaDraft(store, epoch, save), { code: 'AUTHORIZATION_CHANGED' });
});

test('revocation between generation and save or paused save callback refuses persistence', async () => {
  const store = fakeStore(), payload = issue(store);
  const context = { store, assertLive: () => {}, currentAccount: value => assert.equal(value.accountId, 'account-a'),
    status: () => ({}), paused: async (_reason, action) => {
      store.data.authorizationEpochs['account-a'] = 1;
      return action();
    } };
  await assert.rejects(agentMutation(context, 'persona.create', { ...payload, source: 'distilled' }), { code: 'AUTHORIZATION_CHANGED' });
  store.data.authorizationEpochs['account-a'] = 0;
  store.settingsValue.groups = [];
  assert.throws(() => savePersonaDraft(store, payload, () => assert.fail('must not save')), { code: 'PERSONA_SOURCE_REVOKED' });
});

test('derived provenance persists; revocation immediately stops global use and clears only related derived bodies', t => {
  const { store, root } = realStore(t);
  store.setPersona(persona('手写正文，工资12000元属于用户主动编写。'));
  const payload = issue(store);
  savePersonaDraft(store, payload, provenance => store.createPersona({ persona: payload.persona, name: '库标题A', source: 'distilled', provenance }));
  const aId = store.activePersonaId();
  const second = issue(store, source({ personId: 'person-b' }));
  savePersonaDraft(store, second, provenance => store.createPersona({ persona: second.persona, name: '库标题B', source: 'distilled', provenance }));
  const bId = store.activePersonaId();
  store.selectPersona(aId);
  const reloaded = new StateStore(root);
  assert.equal(reloaded.personaEntries().find(entry => entry.id === aId).provenance.personId, 'person-a');
  assert.equal(reloaded.activePersonaId(), aId);
  reloaded.configure('account-a', { ...reloaded.settings('account-a'), privatePeers: ['person-b'] });
  assert.notEqual(reloaded.persona().prompt, payload.persona.prompt);
  assert.notEqual(reloaded.activePersonaId(), aId);
  assert.throws(() => reloaded.selectPersona(aId), { code: 'PERSONA_SOURCE_REVOKED' });
  reloaded.revokeDerivedPersonas([{ accountId: 'account-a', chatType: 'private', peerId: 'person-a' }]);
  const entries = reloaded.personaEntries();
  assert.equal(entries.find(entry => entry.id === aId).disabled, true);
  assert.notEqual(entries.find(entry => entry.id === aId).persona.prompt, payload.persona.prompt);
  assert.equal(entries.find(entry => entry.id === bId).disabled, undefined);
  assert.match(entries.find(entry => entry.id === 'default').persona.prompt, /工资12000/);
});

test('legacy unknown-source distilled entries quarantine only themselves; manual entries remain unrestricted', t => {
  const { store } = realStore(t);
  const manual = validatePersonaEntry({ id: 'manual', name: '人工', source: 'manual', persona: persona('工资、家庭与职业，用户手写可保留。') });
  const old = validatePersonaEntry({ id: 'legacy', name: '旧提炼', source: 'distilled', persona: persona('旧来源私事') });
  store._writePersonas([manual, old], 'legacy');
  assert.equal(store.activePersonaId(), 'manual');
  assert.equal(store.personasView().items.find(entry => entry.id === 'legacy').disabled, true);
  store.revokeDerivedPersonas([{ accountId: 'unrelated', chatType: 'private', peerId: 'nobody' }]);
  assert.equal(store.personaEntries().length, 2);
  assert.match(store.persona().prompt, /用户手写/);
});

test('saving two different library titles does not rename either title to persona.name', t => {
  const { store, root } = realStore(t);
  store.createPersona({ name: '库标题一', persona: persona('正文一') });
  const first = store.activePersonaId();
  store.createPersona({ name: '库标题二', persona: persona('正文二') });
  const second = store.activePersonaId();
  store.setPersona({ ...persona('修改正文二'), name: '改过的助手名字' });
  store.selectPersona(first);
  store.setPersona(persona('修改正文一'));
  const items = new StateStore(root).personaEntries();
  assert.equal(items.find(entry => entry.id === first).name, '库标题一');
  assert.equal(items.find(entry => entry.id === second).name, '库标题二');
});

test('manual API saves are unrestricted; editing persisted distilled content is reviewed again', async t => {
  const { store } = realStore(t);
  const context = { store, assertLive: () => {}, currentAccount: () => {}, status: () => ({}), paused: async (_reason, action) => action() };
  await agentMutation(context, 'persona.save', { persona: persona('用户手写：我的工资12000元，家庭设定可编辑。') });
  assert.match(store.persona().prompt, /12000/);
  const payload = issue(store);
  await agentMutation(context, 'persona.create', { ...payload, source: 'distilled' });
  await assert.rejects(agentMutation(context, 'persona.save', { id: store.activePersonaId(), persona: persona('说话时展示工资12000元。') }),
    { code: 'PERSONA_PRIVACY_REJECTED' });
  assert.equal(store.persona().prompt, payload.persona.prompt);
});

function summaryService(store, output, onModel = () => {}) {
  let calls = 0;
  const service = createPluginService({ store, identity: {},
    worker: { status: () => ({ account: { id: 'account-a' } }) },
    runner: { memoryExecutionSnapshot: async () => ({ selection: { model: 'synthetic-model' } }) },
    channel: { memory: { view: () => ({ entries: rows() }) },
      authorization: { isCleaning: () => false, combine: () => new AbortController().signal } },
    ctx: { llm: { selectionRequest: async () => ({ provider: { baseURL: 'https://synthetic.invalid', stream: false }, apiKey: '' }) },
      fetch: async () => { calls++; onModel(); return Response.json({ choices: [{ finish_reason: 'stop',
        message: { role: 'assistant', content: output } }] }); } },
  });
  return { service, calls: () => calls };
}

test('the real service explicitly falls back after privacy rejection and never returns source snippets', async () => {
  const store = fakeStore(), fixture = summaryService(store, structured('工资12000元，说话简短。'));
  const draft = await fixture.service.call('persona.distill', { accountId: 'account-a', senderId: 'person-a' });
  assert.equal(fixture.calls(), 1);
  assert.equal(draft.summarized, false);
  assert.match(draft.summaryError, /回退为统计模板/);
  assert.doesNotMatch(draft.persona.prompt, /12000|工资/);
  assert.equal(draft.samples, undefined);
  assert.equal(draft.privacyEntities, undefined);
  assert.equal(draft.provenance, undefined);
  assert.equal(typeof draft.draftToken, 'string');
  assert.doesNotThrow(() => savePersonaDraft(store, { ...draft, name: '安全回退' }, () => true));
});

test('the real service returns a verified one-call draft and revocation after generation blocks save', async () => {
  const store = fakeStore(), fixture = summaryService(store, structured());
  const draft = await fixture.service.call('persona.distill', { accountId: 'account-a', senderId: 'person-a' });
  assert.equal(fixture.calls(), 1);
  assert.equal(draft.summarized, true);
  assert.match(draft.persona.prompt, /有一说一/);
  store.data.authorizationEpochs['account-a'] = 1;
  assert.throws(() => savePersonaDraft(store, draft, () => assert.fail('revoked draft must not persist')), { code: 'AUTHORIZATION_CHANGED' });
});

test('revocation during the real model request cancels generation instead of returning a fallback token', async () => {
  const store = fakeStore(), fixture = summaryService(store, structured(), () => { store.data.authorizationEpochs['account-a'] = 1; });
  await assert.rejects(fixture.service.call('persona.distill', { accountId: 'account-a', senderId: 'person-a' }), { code: 'AUTHORIZATION_CHANGED' });
  assert.equal(fixture.calls(), 1);
});

test('a full nine-section language dossier accepts cautious expression tendencies and evidenced situations in one call', async () => {
  const sampleRows = [...rows(), { text: '孩子，哈哈，别急', time: 100000, chatType: 'group' },
    { text: '哥们，说真的，慢慢来', time: 100001, chatType: 'group' }];
  const observations = [
    ['一句话画像', '说话短促，语气收得快。'],
    ['口头禅与高频词', '用「有一说一」接话。'],
    ['语气词', '句尾语气词偏少。'],
    ['语气语调', '说话节奏偏快，断句短。'],
    ['性格特点', '样本中表达倾向较直接，不据此判断固有人格。'],
    ['常见用语与词汇库', '用词中用「哥们」作为泛用称呼。'],
    ['场合分层', '玩笑表达会用笑声应声；认真表达仍用短句。'],
    ['说话禁区', '样本不足，表达禁区未知。'],
    ['口癖样例', '口癖可用「孩子」，这里只是泛用称呼。'],
  ];
  let calls = 0;
  const result = await summarizeStyle({ ctx: {}, selection: {}, profile: styleProfile(sampleRows), samples: styleSamples(sampleRows),
    client: { complete: async () => { calls++; return { finishReason: 'stop', message: { content: JSON.stringify({
      sections: observations.map(([heading, text]) => ({ heading, observations: [{ text, evidence: [0, 1] }] })),
      phrases: ['有一说一', '哥们', '孩子'],
    }) } }; } } });
  assert.equal(calls, 1);
  for (const [heading] of observations) assert(result.text.includes(`## ${heading}`));
  assert.match(result.text, /表达倾向|玩笑表达|认真表达/);
  assert.throws(() => assertStylePrivacy('我的孩子叫合成乙，说话很短。'), { code: 'PERSONA_PRIVACY_REJECTED' });
});

test('saving when all entries are quarantined creates a real manual copy instead of a no-op', async t => {
  const { store } = realStore(t);
  store._writePersonas([{ id: 'legacy', name: '唯一旧条目', source: 'distilled', createdAt: 0,
    persona: persona('原文必须保留') }], 'legacy');
  assert.equal(store.activePersonaId(), null);
  assert.equal(store.personasView().items[0].legacyPersona.prompt, '原文必须保留');
  const context = { store, assertLive: () => {}, currentAccount: () => {}, status: () => ({}), paused: async (_reason, action) => action() };
  await agentMutation(context, 'persona.save', { persona: store.persona() });
  assert.notEqual(store.activePersonaId(), null, 'even an unchanged fallback must persist a real manual entry');
  store.setPersona(persona('用户明确保存的新手写正文'));
  assert.notEqual(store.activePersonaId(), null);
  assert.equal(store.persona().prompt, '用户明确保存的新手写正文');
  assert.equal(store.personaEntries().find(entry => entry.id === 'legacy').persona.prompt, '原文必须保留');
  assert.equal(store.personaEntries().find(entry => entry.id === store.activePersonaId()).source, 'manual');
});

test('provenance is bounded and rejects forged inconsistent scopes', () => {
  assert.throws(() => validatePersonaProvenance(source({ sourceScopes: Array.from({ length: 61 }, () => scope) })), { code: 'INVALID_PERSONA_PROVENANCE' });
  assert.throws(() => validatePersonaProvenance(source({ sourceScopes: [{ ...scope, accountId: 'other' }] })), { code: 'INVALID_PERSONA_PROVENANCE' });
});
