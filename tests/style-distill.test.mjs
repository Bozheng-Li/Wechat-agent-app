import test from 'node:test';
import assert from 'node:assert/strict';
import { styleProfile, describeStyle } from '../modules/agent/style-profile.mjs';
import { composeStylePersona, WARMTH } from '../modules/agent/style-persona.mjs';

const say = (text, time = 0, senderId = 'a') => ({ direction: 'incoming', text, time, senderId });
const burst = (texts, gap = 5000, start = 0) =>
  texts.map((text, index) => say(text, start + index * gap));

test('profile measures length and punctuation without keeping any wording', () => {
  const profile = styleProfile([
    ...burst(['好', '行', '稀了点', '敲到现在', '这谁顶得住啊']),
    ...burst(['嗯', '那我先走了', '明天聊'], 5000, 60_000),
  ]);
  assert.equal(profile.length.median, 3);
  assert(profile.punctuation.none > 80);
  assert(profile.particles['啊'] > 0);
  assert.equal(profile.confidence, 'low', 'a handful of messages must not read as a mature habit');
  // No original sentence may survive into the profile.
  assert.doesNotMatch(JSON.stringify(profile), /稀了点|敲到现在|明天聊/);
});

test('bursts are counted on consecutive turns, and junk rows are dropped', () => {
  const burstsOnly = styleProfile([...burst(['我靠', '真的假的', '牛魔的']), ...burst(['有空吗', '走吧'], 5000, 400_000)]);
  assert.equal(burstsOnly.bursts.count, 2);
  assert.equal(burstsOnly.bursts.averageMessages, 2.5);
  assert(burstsOnly.register.coarse > 0);

  const junk = styleProfile([say('https://example.com/a', 1), say('[图片]', 2), say('ok', 3), say('好的', 4)]);
  assert.equal(junk.messages, 1, 'links, bracket placeholders and latin-only lines are not speech samples');
});

test('warmth lifts the floor monotonically, even for a very terse speaker', () => {
  const profile = styleProfile(Array.from({ length: 40 }, (_, index) => say(['好', '行', '是'][index % 3], index * 1000)));
  const texts = Object.fromEntries(WARMTH.map(warmth => [warmth, composeStylePersona(profile, { name: '甲', warmth })]));
  const band = text => Number(/一般 (\d+) 到 (\d+) 个字/.exec(text)[1]);
  assert(band(texts.terse) < band(texts.balanced), `terse ${band(texts.terse)} vs balanced ${band(texts.balanced)}`);
  assert(band(texts.balanced) < band(texts.warm), `balanced ${band(texts.balanced)} vs warm ${band(texts.warm)}`);
  assert.match(texts.balanced, /不要只剩一两个字/);
  assert.match(texts.terse, /句子照样短/);
});

test('persona rules follow the data instead of a fixed template', () => {
  const terse = styleProfile(Array.from({ length: 40 }, (_, i) => say('短句' + (i % 2), i * 1000)));
  const verbose = styleProfile(Array.from({ length: 40 }, (_, i) =>
    say('这是一段比较长的说明，用来模拟说话比较完整的人，句子会有二十多个字那么长' + (i % 3), i * 1000)));
  const terseText = composeStylePersona(terse);
  const verboseText = composeStylePersona(verbose);
  assert.match(terseText, /不主动给建议/);
  assert.doesNotMatch(verboseText, /不主动给建议/, 'a verbose speaker must not inherit the terse rule');
  assert.match(verboseText, /需要说清楚时可以更长|偶尔长一些/);
  assert.doesNotMatch(terseText, /短句0|短句1/, 'the composer must not quote samples');
});

test('invalid warmth and missing profile fail loudly', () => {
  const profile = styleProfile(Array.from({ length: 30 }, (_, i) => say('好的吧', i * 1000)));
  assert.throws(() => composeStylePersona(profile, { warmth: 'cold' }), /warmth/);
  assert.throws(() => composeStylePersona({}), /缺少说话方式统计/);
  for (const warmth of WARMTH) assert.equal(typeof composeStylePersona(profile, { warmth }), 'string');
  assert.match(describeStyle(profile), /条发言/);
});
