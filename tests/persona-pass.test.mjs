import test from 'node:test';
import assert from 'node:assert/strict';
import { PERSONA_PLANNING_PROMPT, parsePersonaPlan, personaModeOf, personaPassInput } from '../modules/agent/persona-pass.mjs';
import { buildPersonaPassPrompt, buildWechatPrompt } from '../prompts/reply/compose.mjs';
import { emptyPersona, validatePersona } from '../shared/contracts.mjs';
import { personaDraft } from '../frontend/shared/drafts.mjs';

const packet = (over = {}) => JSON.stringify({ request: '对方在说收拾完桌子找不到笔',
  facts: ['对方自己收拾了桌子', '对方找不到笔'], constraints: ['不要给建议'], unknown: ['笔在哪'], ...over });

test('mode is explicit, defaults to standard and has no app A/B fields', () => {
  assert.equal(personaModeOf(), 'standard');
  assert.equal(personaModeOf({ personaMode: 'high-precision' }), 'high-precision');
  assert.equal(personaModeOf({ personaMode: 'high-precision' }, 'standard'), 'standard');
  assert.throws(() => personaModeOf({}, 'random'), { code: 'INVALID_PERSONA' });
  const value = validatePersona({ name: '小满', aliases: [], prompt: '', personaMode: 'high-precision' });
  assert.equal(emptyPersona(value).personaMode, 'high-precision');
  assert.equal(personaDraft(value).personaMode, 'high-precision');
  assert(!('abTest' in personaDraft(value)));
});

test('stage one is a compression step that carries facts, constraints and unknowns', () => {
  const plan = parsePersonaPlan(packet());
  assert.equal(plan.request, '对方在说收拾完桌子找不到笔');
  assert.equal(plan.facts.length, 2);
  assert.equal(plan.constraints[0], '不要给建议');
  assert.equal(plan.unknown[0], '笔在哪');
  assert.equal(plan.draft, undefined, 'stage one must not hand over a written reply');
  assert.equal(parsePersonaPlan('```json\n' + packet() + '\n```').facts.length, 2);
  assert.match(PERSONA_PLANNING_PROMPT, /不写回复正文/);
  assert.match(PERSONA_PLANNING_PROMPT, /不丢失任务所需内容/);
});

test('planning excludes custom persona but preserves system and owner requirements in both strategies', () => {
  for (const promptStrategy of ['legacy', 'progressive-v1']) {
    const prompt = buildWechatPrompt({ persona: { name: '小满', prompt: 'ROLE_STYLE' },
      includePersona: false, prompt: 'OWNER_REQUIREMENT', identityMarkdown: 'GLOBAL_REQUIREMENT', promptStrategy });
    assert(!prompt.includes('ROLE_STYLE'));
    assert(prompt.includes('OWNER_REQUIREMENT')); assert(prompt.includes('GLOBAL_REQUIREMENT'));
  }
  const system = buildPersonaPassPrompt({ persona: { name: '小满', prompt: '喜欢冷幽默。' }, prompt: '少叫名字。' });
  assert.match(system, /小满/); assert.match(system, /喜欢冷幽默/);
  assert.match(system, /packet 不是成稿/);
  assert.match(system, /unknown/);
});

test('stage two input carries the packet and only the recent turns', () => {
  const body = JSON.parse(personaPassInput('他在说谁？', parsePersonaPlan(packet()), {
    history: [
      { text: '原始上文', senderName: '群友', direction: 'incoming' },
      { text: '我先前说的', direction: 'outgoing' },
    ],
  }));
  assert.equal(body.packet.facts.length, 2);
  assert.equal(body.recentConversation[0].speaker, '群友');
  assert.equal(body.recentConversation[1].speaker, '历史账号发言');
  assert.equal(body.recentConversation[0].direction, 'incoming');
  assert.equal(body.recentConversation[1].direction, 'outgoing');
  assert(body.recentConversation[1].explanationViewpoint.includes('历史账号'));
});

test('plain working material remains labelled notes, not an approved final reply or fabricated facts', () => {
  const source = '面都泡上了，调料包还在旁边躺着。';
  assert.deepEqual(parsePersonaPlan(source), { format: 'working-notes', notes: source });
  const otherShape = JSON.stringify({ purpose: '分享', responsePlan: '接话', draft: '草稿' });
  assert.equal(parsePersonaPlan(otherShape).notes, otherShape);
  const extra = parsePersonaPlan(JSON.stringify({ facts: ['事实'], extraDetail: '额外材料' }));
  assert(extra.notes.includes('额外材料'));
});

test('valid long material and more than twenty facts are retained instead of causing a user-visible failure', () => {
  const facts = Array.from({ length: 25 }, (_, i) => `${i}：${'很长的'.repeat(300)}`);
  const result = parsePersonaPlan(packet({ request: '原始任务'.repeat(300), facts }));
  assert.deepEqual(result.facts, facts);
  assert.equal(result.request, '原始任务'.repeat(300));
  assert.equal(parsePersonaPlan(JSON.stringify({ facts: [{ source: '原话', text: '对象化事实' }] })).facts[0], '{"source":"原话","text":"对象化事实"}');
});
