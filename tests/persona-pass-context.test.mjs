import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalAgent } from '../modules/agent/local-loop.mjs';
import { personaPassInput } from '../modules/agent/persona-pass.mjs';
import { parseNaturalDecision } from '../modules/conversation/natural-chat.mjs';
import { buildWechatPrompt } from '../prompts/reply/compose.mjs';

const choice = { provider: 'fixture', model: 'fixture-model' };
const persona = { name: '小满', prompt: 'VOICE_SENTINEL：温和但不改事实', personaMode: 'high-precision' };
const packet = { request: '说明当前有效数量', facts: ['alice 本轮更正数量为 61，来源时间 1000'], constraints: ['保留不确定性'], unknown: ['地点尚有冲突'] };
const result = content => ({ message: { role: 'assistant', content }, finishReason: 'stop', usage: { total_tokens: 1 } });
const call = (name, id = 'read-card') => ({ message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] }, finishReason: 'tool_calls' });
const card = { personId: 'alice', card: { preferences: '数量 61' }, evidence: { preferences: { sourceAt: 1000,
  sources: [{ senderId: 'alice', time: 1000, quote: '现在61，不是16' }] } }, conflicts: [{ field: 'location', reason: '待核实' }] };
const history = [
  { direction: 'incoming', senderId: 'alice', senderName: '同名', time: 1000, order: 1, text: '现在61，不是16' },
  { direction: 'outgoing', senderId: 'owner', senderName: '小满', time: 2000, order: 2, text: '你刚才说61' },
  { direction: 'incoming', senderId: 'bob', senderName: '同名', time: 3000, order: 3, text: '我的16没变' },
];
function fixture(responses, strategy = 'legacy') {
  const requests = [];
  const runner = {
    ctx: { llm: { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'fixture-model' }] } },
    selection: () => choice,
    getRuntimeSettings: () => ({ persona, modelConfig: { webSearch: false, promptStrategy: strategy } }),
    polishReply: async text => text,
    client: { complete: async input => {
      requests.push(structuredClone({ messages: input.messages, tools: input.tools.map(tool => tool.name) }));
      const next = responses.shift(); assert(next, 'unexpected extra model call'); return next;
    } },
  };
  let reads = 0;
  const options = { text: '现在数量多少', history, speaker: { id: 'alice', name: '同名' }, account: { id: 'owner', nickname: '账号名' },
    memory: 'MEMORY_SENTINEL：已提供人物事实；不能把同名 bob 的 16 移给 alice',
    tools: [{ name: 'wechat_role_card', description: '只读人物卡', parameters: { type: 'object' }, execute() { reads++; return JSON.stringify(card); } }] };
  return { runner, requests, options, reads: () => reads };
}

for (const mode of ['ordinary', 'natural', 'media']) test(`${mode} high precision retains role-card sources, conflicts and dialogue identity in expression input`, async () => {
  const first = mode === 'natural' ? JSON.stringify({ action: 'reply', text: '数量话题', packet }) : JSON.stringify(packet);
  const f = fixture([call('wechat_role_card'), result(first), result('当前61，地点仍需确认')]);
  const options = { ...f.options, ...(mode === 'natural' ? { mode: 'natural', naturalDecision: { trigger: 'followup' },
    selectReplyText: raw => parseNaturalDecision(raw).text, allowEmptyReply: true } : {}),
    ...(mode === 'media' ? { selectedReply: () => ({ text: '素材配文', description: '有数量标签的图', kind: 'image' }), allowEmptyReply: true } : {}) };
  const output = await runLocalAgent(f.runner, options);
  assert.equal(output.personaPasses, 2);
  assert.equal(f.reads(), 1);
  assert.equal(f.requests.length, 3);
  assert(!f.requests[0].messages[0].content.includes('VOICE_SENTINEL'));
  const expression = f.requests[2];
  assert.deepEqual(expression.tools, []);
  assert(expression.messages[0].content.includes('VOICE_SENTINEL'));
  const input = JSON.parse(expression.messages[1].content);
  assert.deepEqual(input.packet, packet);
  assert(!Object.hasOwn(input.packet, 'hint'));
  assert.deepEqual(input.recentConversation.map(row => [row.senderId, row.direction, row.time, row.order]),
    [['alice', 'incoming', 1000, 1], ['owner', 'outgoing', 2000, 2], ['bob', 'incoming', 3000, 3]]);
  assert(input.recentConversation[0].explanationViewpoint.includes('当前提问者'));
  assert(input.references.some(row => row.text.includes('MEMORY_SENTINEL')));
  const read = input.references.find(row => row.tool === 'wechat_role_card');
  assert.equal(read.callId, 'read-card');
  assert.deepEqual(JSON.parse(read.text), card);
  if (mode === 'media') assert.equal(input.selectedMedia.description, '有数量标签的图');
  if (mode === 'natural') {
    assert(f.requests[0].messages[0].content.includes('"packet"'));
    assert(!f.requests[0].messages[0].content.includes('"text":"完整的可发送正文"'), 'no incompatible natural draft contract');
  }
});

test('a malformed natural packet retries once without repeating a role-card read', async () => {
  const f = fixture([call('wechat_role_card'), result('{"action":"reply","text":"只写了成稿"}'),
    result(JSON.stringify({ action: 'reply', text: '数量话题', packet })), result('当前61')]);
  const output = await runLocalAgent(f.runner, { ...f.options, mode: 'natural', naturalDecision: { trigger: 'followup' },
    selectReplyText: raw => parseNaturalDecision(raw).text, allowEmptyReply: true });
  assert.equal(output.text, '当前61'); assert.equal(f.reads(), 1); assert.equal(f.requests.length, 4);
  assert(f.requests[2].messages.at(-1).content.includes('自然决策外层'));
});

test('a high-precision greeting still gets both passes, never a silent fast-path downgrade', async () => {
  const f = fixture([result(JSON.stringify({ request: '打招呼', facts: [], constraints: [], unknown: [] })), result('早')]);
  const output = await runLocalAgent(f.runner, { ...f.options, text: '早', tools: [] });
  assert.equal(output.personaMode, 'high-precision'); assert.equal(output.personaPasses, 2); assert.equal(f.requests.length, 2);
});

test('bounded expression evidence marks every omitted area and preserves recent tool order', () => {
  const source = { text: '长'.repeat(26000), direction: 'incoming', senderId: 'alice', time: 1000,
    attachments: Array.from({ length: 10 }, () => ({ type: 'image', description: '图'.repeat(40000) })) };
  const body = JSON.parse(personaPassInput('当前请求', packet, { history: [source], memory: '旧'.repeat(13000),
    toolResults: Array.from({ length: 15 }, (_, i) => ({ name: 'tool-' + i, callId: String(i), content: '证'.repeat(13000) })) }));
  assert.equal(body.recentConversation[0].omitted, true);
  assert(body.recentConversation[0].text.length <= 24000);
  assert.equal(body.references[0].omitted, true);
  assert.equal(body.toolEvidenceOmitted, true);
  assert.deepEqual(body.references.filter(row => row.tool).map(row => row.callId), ['13', '14']);
});

test('SPLIT is a chat delivery contract, not a Moments or internal data protocol', () => {
  for (const mode of ['default', 'nickname', 'scheduled'])
    assert(buildWechatPrompt({ mode, requestText: '测试', persona: { name: '甲', prompt: '温和' } }).includes('<SPLIT>'));
  for (const mode of ['moments-reply', 'moments-publish', 'memory', 'vision'])
    assert(!buildWechatPrompt({ mode, requestText: '测试', systemOverride: 'SPECIFIC_OUTPUT' }).includes('<SPLIT>'), mode);
});
