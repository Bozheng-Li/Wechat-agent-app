import test from 'node:test';
import assert from 'node:assert/strict';
import { relevantMemoryReference } from '../modules/memory/query/tool.mjs';
import { replyMemoryContext } from '../modules/conversation/reply-context.mjs';

const entry = (key, text, senderId = 'alice', time = 1000) => ({ key, text, senderId, senderName: senderId,
  direction: 'incoming', time });

test('an unpunctuated assistant wake name does not retrieve unrelated old exchanges', () => {
  const old = [entry('1', '小满帮我看看会议材料'), entry('2', '小满来聊一下项目')]
    .map(row => JSON.stringify(row)).join('\n');
  const reference = relevantMemoryReference(old, '小满她不高兴了', { names: ['小满'] });
  assert.equal(reference.text, '');
  assert(!reference.matchedTerms.includes('小满'));
  const subject = relevantMemoryReference(JSON.stringify(entry('3', '小满鱼的价格是20')), '小满鱼的价格', { names: ['小满'] });
  assert(subject.text.includes('价格是20'), 'part of a word is not a wake prefix');
});

test('a detached model summary remains labelled as an older summary instead of a user assertion', () => {
  const source = '已保存的会话记忆（压缩摘要，可能有信息损耗）：\n阿禾咖啡喜欢牛奶。\n\n最近的会话原文（按接收顺序）：\n' +
    JSON.stringify(entry('recent', '我咖啡现在只喝豆奶。', 'alice', 2000));
  const result = relevantMemoryReference(source, '咖啡喜欢哪种奶');
  const rows = result.text.split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].sourceType, 'conversation-summary');
  assert(rows[0].status.includes('后续明确更正优先'));
  assert.equal(rows[1].senderId, 'alice');
  assert.equal(rows[1].time, 2000);
});

test('a relevant recent correction follows the older summary with attribution and within budget', () => {
  const snapshot = { summary: '阿禾咖啡喜欢牛奶。', entries: [entry('current', '我咖啡现在改喝豆奶，不加牛奶。', 'alice', 2000)] };
  const original = structuredClone(snapshot);
  const result = replyMemoryContext({ snapshot, text: '咖啡加什么奶', promptStrategy: 'progressive-v1' });
  const rows = result.memory.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(rows[0].sourceType, 'conversation-summary');
  const correction = rows.at(-1);
  assert.equal(correction.sourceType, 'recent-direct-correction');
  assert.equal(correction.senderId, 'alice');
  assert.equal(correction.time, 2000);
  assert.equal(correction.text, snapshot.entries[0].text);
  assert(result.referenceChars <= 3000);
  assert.deepEqual(snapshot, original, 'a read must not rewrite the saved summary');
});

test('quoted and unrelated corrections do not add unrelated context or broaden on-demand mode', () => {
  const snapshot = { summary: '咖啡可以加牛奶。', entries: [entry('quote', '他写了“我咖啡现在改喝豆奶”。')] };
  const result = replyMemoryContext({ snapshot, text: '咖啡加奶吗' });
  assert(!result.memory.includes('recent-direct-correction'));
  const separate = replyMemoryContext({ snapshot, text: '写一个计算加法的函数' });
  assert.equal(separate.memory, undefined);
  const onDemand = replyMemoryContext({ snapshot, text: '咖啡加奶吗', onDemand: true });
  assert.equal(onDemand.memory, undefined);
});

test('a correction never overwrites another speaker or bypasses a tight role-memory budget', () => {
  const snapshot = { summary: '', entries: [entry('current', '我咖啡现在改喝豆奶。', 'bob', 4000)] };
  const result = replyMemoryContext({ snapshot, text: '咖啡喜欢哪种奶', role: {
    memory: 'R'.repeat(2800), legacyMemory: '阿禾咖啡喜欢牛奶。',
  } });
  assert(result.referenceChars <= 3000);
  assert.equal(snapshot.entries[0].senderId, 'bob');
  assert(!result.memory.includes('"senderId":"alice"'));
});
