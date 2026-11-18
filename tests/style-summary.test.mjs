import test from 'node:test';
import assert from 'node:assert/strict';
import { styleProfile } from '../modules/agent/style-profile.mjs';
import { profileSheet, styleSamples, styleSummaryMessages, summarizeStyle, STYLE_SUMMARY_PROMPT } from '../modules/agent/style-summary.mjs';

const profile = styleProfile([
  { direction: 'incoming', text: '稀了点', time: 1000 },
  { direction: 'incoming', text: '敲这么久', time: 2000 },
  { direction: 'incoming', text: '行', time: 3000 },
  { direction: 'incoming', text: '稀了点', time: 124_000 },
  ...Array.from({ length: 24 }, (_, index) => ({ direction: 'incoming', text: '第' + index + '条', time: 200_000 + index * 1000 })),
]);

test('the measurement sheet carries numbers and distinguishes low frequency from a prohibition', () => {
  const sheet = profileSheet(profile);
  for (const key of ['样本', '长度', '占比', '标点', '连发', '语气', '常用语气词', '不是禁用']) assert(sheet.includes(key), key);
  assert.match(sheet, /中位 \d+ 字/);
});

test('explicit assistant tasks are dropped but a human mention and a greeting remain as anonymized evidence', () => {
  const samples = styleSamples([
    { text: '小胖，评价一下这个方案', time: 4 }, { text: '@某甲 你看着办', time: 3 },
    { text: '稀了点', time: 2 }, { text: '行', time: 1 }, { text: '小胖，早上好', time: 5 },
  ], { exclude: ['小胖', '胖'] });
  assert.deepEqual(samples.map(row => row.text), ['[称呼],早上好', '[称呼] 你看着办', '稀了点', '行']);
});

test('source evidence preserves recurrence, is latest-first and bounded, and removes links and oversized lines', () => {
  const samples = styleSamples([
    { text: '稀了点', time: 1 }, { text: '稀了点', time: 2 }, { text: 'https://example.com/x', time: 3 },
    { text: '[图片]', time: 4 }, { text: '长'.repeat(81), time: 5 }, { text: '行', time: 6 }, { text: '  敲这么久  ', time: 7 },
  ]);
  assert.deepEqual(samples.map(row => row.text), ['敲这么久', '行', '稀了点', '稀了点']);
  const latest = styleSamples(Array.from({ length: 400 }, (_, i) => ({ text: '反正就是这样吧', time: i + 1 })));
  assert.equal(latest.length, 220);
  assert.equal(latest[0].time, 400);
  assert.equal(latest.at(-1).time, 181);
});

test('the prompt uses anonymized real language, structured evidence and unknown context instead of unsupported biography', () => {
  const messages = styleSummaryMessages({ target: '合成人物甲', profile, samples: ['稀了点', '行'] });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, STYLE_SUMMARY_PROMPT);
  for (const aspect of ['长度和节奏', '语气与用词', '口头禅与高频词', '场合证据', 'JSON', 'evidence']) assert(STYLE_SUMMARY_PROMPT.includes(aspect), aspect);
  assert.match(STYLE_SUMMARY_PROMPT, /不要编造/);
  assert.match(STYLE_SUMMARY_PROMPT, /一律未知/);
  const user = messages[1].content;
  assert(!user.includes('合成人物甲'), 'the real target name does not reach the model');
  assert(user.includes('稀了点') && user.includes('行'), 'safe real language still reaches the model');
  assert(user.includes('chatType') && user.includes('unknown'));
});

const client = result => ({ complete: async () => result, providers: undefined });
const valid = JSON.stringify({ sections: [{ heading: '长度和节奏', observations: [{ text: '一条一般四到十字。', evidence: [0] }] }], phrases: ['稀了点'] });

test('one complete structured summary becomes a verified persona draft', async () => {
  let calls = 0;
  const summary = await summarizeStyle({ ctx: {}, selection: {}, target: '甲', profile, samples: ['稀了点'],
    client: { complete: async () => { calls++; return { message: { content: valid }, finishReason: 'stop', usage: { total_tokens: 900 } }; } } });
  assert.match(summary.text, /一条一般四到十字/);
  assert.match(summary.text, /稀了点/);
  assert.equal(summary.usage.total_tokens, 900);
  assert.equal(calls, 1);
});

test('truncated, empty and malformed summaries fail rather than becoming a persona', async () => {
  await assert.rejects(() => summarizeStyle({ ctx: {}, selection: {}, profile, samples: ['稀了点'],
    client: client({ message: { content: '写到一半' }, finishReason: 'length' }) }), { code: 'PERSONA_SUMMARY_INCOMPLETE' });
  await assert.rejects(() => summarizeStyle({ ctx: {}, selection: {}, profile, samples: ['稀了点'],
    client: client({ message: { content: '   ' }, finishReason: 'stop' }) }), { code: 'PERSONA_SUMMARY_EMPTY' });
  await assert.rejects(() => summarizeStyle({ ctx: {}, selection: {}, profile, samples: ['稀了点'],
    client: client({ message: { content: 'not json' }, finishReason: 'stop' }) }), { code: 'PERSONA_SUMMARY_SCHEMA' });
  await assert.rejects(() => summarizeStyle({ ctx: {}, selection: {}, profile, samples: [] }), { code: 'PERSONA_SAMPLE_SMALL' });
});
