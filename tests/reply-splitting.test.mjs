import test from 'node:test';
import assert from 'node:assert/strict';
import { replySegments, splitChatReply, SPLIT_MARK } from '../shared/chat-reply-split.mjs';

test('没有标记就是一条消息，换行原样保留', () => {
  const text = '我靠\n区就是蛆的谐音\n说人菜得离谱';
  assert.deepEqual(splitChatReply(text), [text]);
  assert.deepEqual(splitChatReply('两小时换个明天再开。'), ['两小时换个明天再开。']);
});

test('插了标记就按标记分条', () => {
  assert.deepEqual(splitChatReply('我靠<SPLIT>区就是蛆的谐音<SPLIT>说人菜'), ['我靠', '区就是蛆的谐音', '说人菜']);
  assert.deepEqual(splitChatReply('行\n<SPLIT>\n吧'), ['行', '吧']);
  assert.deepEqual(splitChatReply('先说结论<SPLIT>再补一句'), ['先说结论', '再补一句']);
  assert.deepEqual(splitChatReply('第一<split>第二'), ['第一', '第二'], '标记不区分大小写');
});

test('标记周围的空白和多余换行不会变成空消息', () => {
  assert.deepEqual(splitChatReply('  A  <SPLIT>  B  '), ['A', 'B']);
  assert.deepEqual(splitChatReply('A<SPLIT><SPLIT>B'), ['A', 'B']);
  assert.deepEqual(splitChatReply('<SPLIT>'), []);
  assert.deepEqual(splitChatReply(''), []);
  assert.deepEqual(splitChatReply(null), []);
});

test('一条消息内部的换行不受影响', () => {
  const withLines = '步骤：\n```\ngit log -1\n```\n照这个来';
  assert.deepEqual(splitChatReply(withLines), [withLines]);
});

test('代码块里的标记是字面内容，不触发分条', () => {
  const code = '这样写：\n```\nif (a <SPLIT> b) {}\n```';
  assert.deepEqual(splitChatReply(code), [code]);
  const mixed = '先看这段<SPLIT>```\nx <SPLIT> y\n```';
  assert.deepEqual(splitChatReply(mixed), ['先看这段', '```\nx <SPLIT> y\n```']);
});

test('啰嗦人设不插标记，多段长文仍然是一条', () => {
  const verbose = '这个问题的原因有两层。第一层是磁盘写入失败。\n第二层是权限没有同步。\n我建议先看日志再动手。';
  assert.deepEqual(splitChatReply(verbose), [verbose]);
});

const text = value => ({ type: 'text', data: { text: value } });
const at = value => ({ type: 'at', data: { qq: value } });

test('每条拆分结果单独发送，@ 只挂在第一条', () => {
  const segments = replySegments([at('alice'), text('我靠'), text('人设就小胖'), text('不苟言笑咋了')]);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0].map(part => part.type), ['at', 'text']);
  assert.deepEqual(segments[1], [text('人设就小胖')]);
  assert.deepEqual(segments[2], [text('不苟言笑咋了')]);
});

test('单条正文不猜分条，媒体拥有独立气泡并保持顺序', () => {
  assert.equal(replySegments([text('两小时换个明天再开。')]).length, 1);
  const image = { type: 'image', data: {} };
  assert.deepEqual(replySegments([at('bob'), text('甲'), text('乙'), image]), [[at('bob'), text('甲')], [text('乙')], [image]]);
  assert.equal(replySegments([at('bob'), text('收到')]).length, 1);
});

test('代码围栏长度、波浪围栏、开头字面标记和空行完整保留', () => {
  for (const fence of ['```', '~~~~']) {
    const code = `${fence}text <SPLIT>\na\n\nb<SPLIT>c\n${fence}`;
    assert.deepEqual(splitChatReply(`甲<SPLIT>${code}<SPLIT>乙`), ['甲', `${code}<SPLIT>乙`], '非独立闭围栏保持字面');
    assert.deepEqual(splitChatReply(`甲<SPLIT>${code}\n<SPLIT>乙`), ['甲', code, '乙']);
  }
  assert.deepEqual(splitChatReply('a\n\nb'), ['a\n\nb']);
});

test('标记本身不会漏到发出的正文里', () => {
  const parts = splitChatReply('A<SPLIT>B<SPLIT>C');
  assert(parts.every(part => !part.includes(SPLIT_MARK)));
});
