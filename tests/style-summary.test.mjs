import test from 'node:test';
import assert from 'node:assert/strict';
import { styleProfile } from '../modules/agent/style-profile.mjs';
import { profileSheet, styleSamples, styleSummaryMessages, summarizeStyle, STYLE_SUMMARY_PROMPT } from '../modules/agent/style-summary.mjs';

const rows = [{ direction: 'incoming', text: '稀了点', time: 1000 }, { direction: 'incoming', text: '有一说一，这句话可以直接点', time: 2000 }];
const profile = styleProfile(rows);
const client = (content, finishReason = 'stop') => ({ complete: async () => ({ message: { content }, finishReason, usage: { total_tokens: 12 } }) });

test('statistics remain reference data, not a persona or a ban on low frequency words', () => {
  const sheet = profileSheet(profile);
  assert.match(sheet, /中位 \d+ 字/); assert.match(sheet, /不代表禁止/);
  assert.match(STYLE_SUMMARY_PROMPT, /不是回复字数上限/);
});

test('real phrases, long lines, digits and English survive sampling while direct assistant tasks are separated', () => {
  const samples = styleSamples([{ text: '助手，帮我总结一下' }, { text: '助手，早上好' }, { text: '@某甲 你看着办' },
    { text: '长'.repeat(81) }, { text: '我今天说了3次这个词' }, { text: 'okay then' }], { exclude: ['助手'] });
  assert.equal(samples.length, 5);
  assert(samples.some(row => row.text === '[称呼]，早上好'));
  assert(samples.some(row => row.text === '[称呼] 你看着办'));
  assert(samples.some(row => row.text === '长'.repeat(81)));
  assert(samples.some(row => row.text === '我今天说了3次这个词'));
  assert(samples.some(row => row.text === 'okay then'));
});

test('newest samples are bounded without deleting repeated speech or scene context', () => {
  const samples = styleSamples(Array.from({ length: 400 }, (_, i) => ({ text: '反正就是这样吧', time: i+1,
    chatType: 'group', conversation: '会话1', context: [{ speaker: '其他成员', text: '怎么说？' }] })));
  assert.equal(samples.length, 220); assert.equal(samples[0].time, 400); assert.equal(samples.at(-1).time, 181);
  assert.equal(samples[0].context[0].text, '怎么说？');
});

test('model receives actual language and warmth preference, and is asked for Markdown rather than evidence JSON', () => {
  const messages = styleSummaryMessages({ profile, samples: styleSamples(rows), warmth: 'warm' });
  assert.equal(messages[0].content, STYLE_SUMMARY_PROMPT);
  for (const text of ['口头禅', '语气词', '性格', '场合']) assert(STYLE_SUMMARY_PROMPT.includes(text));
  assert.match(messages[1].content, /增加温度/); assert.match(messages[1].content, /稀了点/);
  assert(!STYLE_SUMMARY_PROMPT.includes('只返回JSON'));
});

test('plain Markdown and long quoted examples are preserved without subjective content approval', async () => {
  const body = '# 人物语言档案\n## 性格特点\n说话直接，熟人之间爱调侃。\n## 口头禅\n“今天这个事情真是有点离谱了吧”。';
  const result = await summarizeStyle({ ctx: {}, selection: {}, profile, samples: styleSamples(rows), client: client(body) });
  assert.equal(result.text, body); assert.equal(result.usage.total_tokens, 12);
});

test('a partial model result remains editable with a warning; only no data/no output fails honestly', async () => {
  const result = await summarizeStyle({ ctx: {}, selection: {}, profile, samples: styleSamples(rows), client: client('写到这里的真实正文', 'length') });
  assert.equal(result.text, '写到这里的真实正文'); assert(result.warning);
  await assert.rejects(summarizeStyle({ ctx: {}, selection: {}, profile, samples: styleSamples(rows), client: client('   ') }), { code: 'PERSONA_SUMMARY_EMPTY' });
  await assert.rejects(summarizeStyle({ ctx: {}, selection: {}, profile, samples: [] }), { code: 'PERSONA_SAMPLE_EMPTY' });
  await assert.rejects(summarizeStyle({ ctx: {}, selection: {}, profile, samples: styleSamples(rows), client: { complete: async () => { throw Error('real network error'); } } }), /real network error/);
});
