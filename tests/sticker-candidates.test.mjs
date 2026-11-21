import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStickerCandidates } from '../modules/media/sticker-candidates.mjs';
import { stickerReplyTools } from '../modules/media/sticker-tools.mjs';
import { runLocalAgent } from '../modules/agent/local-loop.mjs';
import { parseNaturalDecision } from '../modules/conversation/natural-chat.mjs';

const asset = (id, name, usage, extra = {}) => ({ id, name, usage, description: usage, tags: [], kind: 'sticker', ...extra });

test('relevant older stickers outrank forty newer unrelated ones, without selecting/sending', () => {
  const unrelated = Array.from({ length: 40 }, (_, i) => asset('new-' + i, '新图' + i, '讨论猫的生活', { createdAt: 100 + i }));
  const old = asset('thanks', '谢谢啦', '表示感谢与感激', { createdAt: 1 });
  const input = [...unrelated, old], before = structuredClone(input);
  const result = selectStickerCandidates(input, { text: '谢谢你，帮大忙了', random: () => 0 });
  assert.equal(result.candidates[0].id, 'thanks');
  assert.equal(result.eligibleCount, 41); assert(result.relevantCount > 0);
  assert.deepEqual(input, before, 'candidate suggestion is read-only');
});

test('current topic outweighs old context and favorites cannot hide a matching non-favorite', () => {
  const input = [asset('laugh', '笑死了', '开心大笑', { nativeSticker: { favorite: true } }), asset('sleep', '晚安', '晚安睡觉')];
  const result = selectStickerCandidates(input, { text: '有点困了，晚安', history: [{ text: '哈哈哈' }], random: () => 0 });
  assert.equal(result.candidates[0].id, 'sleep');
});

test('spontaneous candidates need reliable meaning, explicit requests may still browse unlabeled stickers', () => {
  const input = [asset('known', '点头', '赞同'), asset('blank', '无说明', '')];
  assert.deepEqual(selectStickerCandidates(input).candidates.map(row => row.id), ['known']);
  assert.equal(selectStickerCandidates(input, { explicitRequest: true }).candidates.length, 2);
});

test('pre-read candidate description is visible even without usage and direct selection requires no extra read', async () => {
  const item = asset('picture', '名称', '', { description: '点头表示同意。' });
  let selected;
  const tools = stickerReplyTools({ resolveAsset: () => item }, { accountId: 'owner' }, () => {}, value => { selected = value; }, { candidates: [item] });
  const send = tools.find(tool => tool.name === 'wechat_sticker_send');
  assert(send.description.includes('点头表示同意'));
  assert(send.description.includes('不必再调用 read'));
  assert.equal(JSON.parse(await send.execute({ assetId: item.id }, { signal: new AbortController().signal })).ok, true);
  assert.equal(selected.asset.id, item.id);
});

test('natural runner exposes only role-card and sticker tools, never unrelated mutations', async () => {
  const requests = [];
  const runner = { ctx: { llm: { listProviders: () => [{ id: 'test' }], listModels: async () => [{ id: 'model' }] } },
    selection: () => ({ provider: 'test', model: 'model' }), getRuntimeSettings: () => ({ persona: { name: '助手', prompt: '' }, modelConfig: {} }),
    client: { complete: async input => { requests.push(input.tools.map(tool => tool.name)); return { message: { content: '{"action":"skip","reason":"no_topic","text":""}' }, finishReason: 'stop' }; } },
    polishReply: async text => text };
  const names = ['wechat_role_card', 'wechat_sticker_read', 'wechat_sticker_send', 'wechat_task', 'wechat_generate_image'];
  await runLocalAgent(runner, { text: '话题', mode: 'natural', naturalDecision: { trigger: 'timer' },
    tools: names.map(name => ({ name, description: name, execute: async () => '{}' })),
    selectReplyText: raw => parseNaturalDecision(raw).text, allowEmptyReply: true });
  assert.deepEqual(requests[0], names.slice(0,3));
});

for (const mode of ['natural', 'participate']) test(`${mode} high precision can choose a pure sticker without fabricating a text pass`, async () => {
  const item = asset('known', '点头', '赞同与感谢'); let selected, calls = 0;
  const tools = stickerReplyTools({ resolveAsset: () => item }, { accountId: 'owner' }, () => {}, value => { selected = value; }, { candidates: [item] });
  const runner = { ctx: { llm: { listProviders: () => [{ id: 'test' }], listModels: async () => [{ id: 'model' }] } },
    selection: () => ({ provider: 'test', model: 'model' }),
    getRuntimeSettings: () => ({ persona: { name: '助手', prompt: '自然', personaMode: 'high-precision' }, modelConfig: {} }),
    polishReply: async text => text,
    client: { complete: async () => ++calls === 1
      ? { message: { content: null, tool_calls: [{ id: 'select', type: 'function', function: { name: 'wechat_sticker_send', arguments: '{"assetId":"known","caption":null}' } }] }, finishReason: 'tool_calls' }
      : { message: { content: '{"action":"reply","text":""}' }, finishReason: 'stop' } } };
  const result = await runLocalAgent(runner, { text: '有新的感谢话题', mode, naturalDecision: { trigger: 'count', allowColdOpening: false }, tools,
    selectedReply: () => selected ? { text: selected.caption, description: selected.asset.description } : null,
    selectReplyText: raw => parseNaturalDecision(raw, { allowEmptyReply: !!selected }).text, allowEmptyReply: () => !!selected });
  assert.equal(calls, 2); assert.equal(result.text, ''); assert.equal(result.personaApplied, false);
  assert.equal(selected.asset.id, item.id);
});

test('natural empty text is valid only when the caller already selected media', () => {
  const raw = '{"action":"reply","text":""}';
  assert.throws(() => parseNaturalDecision(raw), { code: 'NATURAL_DECISION_INVALID' });
  assert.equal(parseNaturalDecision(raw, { allowEmptyReply: true }).action, 'reply');
  assert.throws(() => parseNaturalDecision('{"action":"skip","reason":"no_topic","text":"wrong"}', { allowEmptyReply: true }), { code: 'NATURAL_DECISION_INVALID' });
});
