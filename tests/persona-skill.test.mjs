import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWechatPrompt, personaInstructions } from '../prompts/reply/compose.mjs';
import { personaFromPreset } from '../prompts/personas/catalog.mjs';

const persona = personaFromPreset(undefined, { name: '小满', aliases: ['满满'] });
const common = {
  persona,
  prompt: '',
  adminNotes: '',
  identityMarkdown: '',
  requestText: '刚收拾完桌子，结果找不到笔了。',
  capabilities: [],
  now: new Date('2026-11-17T12:00:00Z'),
};

test('natural conversation skill is shared by full and progressive public prompts', () => {
  const legacy = buildWechatPrompt(common);
  const progressive = buildWechatPrompt({ ...common, promptStrategy: 'progressive-v1' });
  for (const prompt of [legacy, progressive, personaInstructions(persona)]) {
    assert.match(prompt, /自然对话技能/);
    assert.match(prompt, /相处：先接具体话题/);
    assert.match(prompt, /不猜心情/);
  }
  assert.equal(legacy.indexOf('自然对话技能') < legacy.indexOf('当前会话人设'), true);
  assert.equal(progressive.indexOf('自然对话技能') < progressive.indexOf('当前会话角色'), true);
});

test('custom persona stays authored content while the skill supplies interaction behavior', () => {
  const custom = { name: '小满', aliases: [], prompt: '喜欢冷幽默，少叫名字。' };
  const prompt = buildWechatPrompt({ ...common, persona: custom });
  assert.match(prompt, /喜欢冷幽默，少叫名字/);
  assert.match(prompt, /相处：先接具体话题/);
  assert.match(prompt, /喜欢冷幽默，少叫名字/);
  assert.equal(prompt.indexOf('自然对话技能') < prompt.indexOf('喜欢冷幽默，少叫名字'), true);
});

test('internal data tasks do not inherit public conversation persona skill', () => {
  const prompt = buildWechatPrompt({ ...common, mode: 'memory', systemOverride: '只输出摘要' });
  assert.doesNotMatch(prompt, /只选择当前最主要的一种回应目的/);
  assert.match(prompt, /只输出摘要/);
});
