import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { replyClock, replyTimeZone, localMessageTime } from '../prompts/shared/time.mjs';
import { REPLY_CLOCK_RULE, replyClockInstructions } from '../prompts/reply/clock.mjs';
import { buildWechatPrompt } from '../prompts/reply/compose.mjs';
import { runLocalAgent } from '../modules/agent/local-loop.mjs';
import { parseNaturalDecision } from '../modules/conversation/natural-chat.mjs';
import { StateStore } from '../backend/storage/state-store.mjs';
import { WechatChannel } from '../modules/conversation/channel.mjs';

const now = Date.parse('2026-11-19T11:05:47+08:00');
const messageTime = Date.parse('2026-11-19T11:02:45+08:00') / 1000;
const historyTime = Date.parse('2026-11-18T22:30:00+08:00');
const packet = { request: '回应当前消息', facts: [], constraints: [], unknown: [] };
const done = content => ({ message: { role: 'assistant', content }, finishReason: 'stop' });

test('current message date anchors survive midnight and year boundaries beside untouched original text', async () => {
  const { messageDateContext } = await import('../prompts/reply/clock.mjs');
  const { conversationInputMessages } = await import('../modules/agent/conversation-input.mjs');
  const clock = replyClock({ now: Date.parse('2027-01-01T00:00:10+08:00'), messageTime: Date.parse('2026-12-31T23:59:50+08:00'), timeZone: 'Asia/Shanghai' });
  const context = messageDateContext(clock);
  assert(context.includes('"today":"2026-12-31"'));
  assert(context.includes('"tomorrow":"2027-01-01"'));
  assert(context.includes('"replyDate":"2027-01-01"'));
  const original = '明天上午十点见';
  const last = conversationInputMessages({ current: original, clock }).at(-1).content;
  assert(last.includes(context)); assert(last.endsWith(original));
  assert.equal(messageDateContext(replyClock({ now })), '');
});

// These tests verify clock plumbing and instructions, not a real model's interpretation.
test('clock converts the same instant to local time without treating UTC as local', () => {
  assert.deepEqual(replyClock({ now, messageTime, timeZone: 'Asia/Shanghai' }), {
    timeZone: 'Asia/Shanghai', currentTime: '2026-11-19T11:05:47+08:00', currentDayPeriod: '上午', messageTime: '2026-11-19T11:02:45+08:00',
  });
  assert.deepEqual(replyClock({ now: () => now, messageTime, timeZone: 'Asia/Shanghai' }), replyClock({ now, messageTime, timeZone: 'Asia/Shanghai' }));
  assert.equal(localMessageTime(messageTime * 1000, 'Asia/Shanghai'), localMessageTime(messageTime, 'Asia/Shanghai'));
  assert.equal(localMessageTime('2026-11-19T03:05:47Z', 'Asia/Shanghai'), '2026-11-19T11:05:47+08:00');
  assert.equal(replyClock({ now, timeZone: 'UTC' }).currentTime, '2026-11-19T03:05:47+00:00');
  assert.equal(replyClock({ now, timeZone: 'Asia/Kolkata' }).currentTime, '2026-11-19T08:35:47+05:30');
  assert.equal(replyClock({ now, timeZone: 'America/New_York' }).currentTime, '2026-11-18T22:05:47-05:00');
  assert.equal(localMessageTime('2026-07-19T03:05:47Z', 'America/New_York'), '2026-07-18T23:05:47-04:00');
  assert.equal(replyTimeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');
  assert.equal(replyClock({ now }).messageTime, null, 'no invented original-message timestamp');
});

test('configured runtime timezone is honored and an explicit reply timezone takes precedence', async () => {
  const requests = [];
  const runner = {
    ctx: { llm: { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'fixture-model' }] } },
    selection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    getRuntimeSettings: () => ({ timeZone: 'Asia/Kolkata', modelConfig: { webSearch: false } }),
    polishReply: async text => text,
    client: { complete: async input => { requests.push(input.messages); return done('合成回应'); } },
  };
  await runLocalAgent(runner, { text: '现在呢', now });
  await runLocalAgent(runner, { text: '现在呢', now, timeZone: 'UTC' });
  assert(requests[0][0].content.includes('当前时间：2026-11-19T08:35:47+05:30，时区 Asia/Kolkata'));
  assert(requests[1][0].content.includes('当前时间：2026-11-19T03:05:47+00:00，时区 UTC'));
});

test('both prompt strategies retain the clock for greetings and distinguish sticker text from present time', () => {
  for (const promptStrategy of ['legacy', 'progressive-v1']) {
    for (const requestText of ['早', '晚安', '表情上写着晚安', '虽然是白天，我下夜班要睡了']) {
      const system = buildWechatPrompt({ requestText, promptStrategy, now, messageTime, timeZone: 'Asia/Shanghai' });
      assert(system.includes('当前时间：2026-11-19T11:05:47+08:00'));
      assert(system.includes('原消息时间：2026-11-19T11:02:45+08:00'));
      assert(system.includes(REPLY_CLOCK_RULE));
      assert(!system.includes('只解释相对日期'));
    }
  }
});

for (const strategy of ['legacy', 'progressive-v1']) {
  for (const personaMode of ['standard', 'high-precision']) {
    for (const kind of ['ordinary', 'natural', 'participate', 'media', 'natural-media']) {
      test(`${strategy} ${personaMode} ${kind} shares one reply clock across text, tools and expression`, async () => {
        const natural = ['natural', 'participate', 'natural-media'].includes(kind), media = kind.includes('media');
        const high = personaMode === 'high-precision';
        const requests = [];
        let selectedMedia, clockReads = 0, fakeNow = now;
        const persona = { name: '合成助手', prompt: '自然简短', personaMode };
        const runner = {
          ctx: { llm: { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'fixture-model' }] } },
          selection: () => ({ provider: 'fixture', model: 'fixture-model' }),
          getRuntimeSettings: () => ({ persona, timeZone: 'Asia/Shanghai', modelConfig: { promptStrategy: strategy, webSearch: false } }),
          polishReply: async text => text,
          client: { complete: async input => {
            requests.push(structuredClone(input.messages));
            fakeNow += 60_000;
            if (media && requests.length === 1) return { message: { role: 'assistant', content: null,
              tool_calls: [{ id: 'sticker', type: 'function', function: { name: 'wechat_sticker_send', arguments: '{"caption":"配文"}' } }] }, finishReason: 'tool_calls' };
            const expression = high && requests.length === (media ? 3 : 2);
            if (expression) return done('合成回应');
            if (natural) return done(JSON.stringify({ action: 'reply', text: high ? '当前话题' : '合成回应', ...(high ? { packet } : {}) }));
            return done(high ? JSON.stringify(packet) : '合成回应');
          } },
        };
        const result = await runLocalAgent(runner, {
          text: '表情上写着晚安', persona, now: () => { clockReads++; return fakeNow; }, messageTime,
          mode: kind === 'participate' ? 'participate' : natural ? 'natural' : 'default',
          history: [{ time: historyTime, direction: 'incoming', senderId: 'synthetic-user', text: '历史里的晚上好' }],
          speaker: { id: 'synthetic-user', name: '合成成员' },
          tools: media ? [{ name: 'wechat_sticker_send', description: '合成表情工具', parameters: { type: 'object' }, execute(args) {
            selectedMedia = { text: args.caption, description: '写着晚安的贴图', kind: 'sticker' };
            return { selected: true };
          } }] : [],
          ...(natural ? { naturalDecision: { trigger: 'followup' } } : {}),
          selectedReply: () => selectedMedia,
          selectReplyText: raw => natural ? parseNaturalDecision(raw).text : selectedMedia?.text || raw,
        });
        assert.equal(clockReads, 1, 'not sampled at receive time or independently in each stage');
        assert.equal(result.personaPasses, high ? 2 : 1);
        assert.equal(requests.length, (high ? 2 : 1) + (media ? 1 : 0));
        const expected = replyClock({ now, messageTime, timeZone: 'Asia/Shanghai' });
        for (const request of requests) assert(request[0].content.includes(replyClockInstructions(expected)));
        assert(requests[0].some(message => message.content.includes('2026-11-18T22:30:00+08:00')));
        if (high) {
          const expression = JSON.parse(requests.at(-1)[1].content);
          assert.deepEqual(expression.clock, expected);
          assert.equal(expression.recentConversation[0].time, historyTime);
          assert.equal(expression.recentConversation[0].localTime, '2026-11-18T22:30:00+08:00');
          if (media) assert.equal(expression.selectedMedia.description, '写着晚安的贴图');
        }
      });
    }
  }
}

test('queued channel replies keep original message seconds and sample the later generation time', { timeout: 10000 }, async t => {
  const base = path.resolve('storage/tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'reply-clock-'));
  const account = { id: 'clock-fixture-owner', nickname: '合成账号' };
  const store = new StateStore(root);
  store.configure(account.id, { enabled: true, privatePeers: ['clock-fixture-user'], groups: [], prompt: '' });
  let at = Date.parse('2026-11-18T23:59:50+08:00');
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), clocks = [];
  const runner = { run: async input => {
    if (input.text === '第一条') { entered.resolve(); await gate.promise; }
    if (input.text === '第二条') clocks.push(replyClock({ now: input.now(), messageTime: input.messageTime, timeZone: 'Asia/Shanghai' }));
    return { text: '合成回应' };
  } };
  const transport = { status: () => ({ online: true, account }), send: async () => ({ delivery: 'server-ack', serverMessageIds: ['synthetic-ack'] }) };
  const channel = new WechatChannel({ store, runner, transport, now: () => at });
  t.after(async () => {
    gate.resolve(); await channel.close();
    const resolved = fs.realpathSync(root), relative = path.relative(base, resolved);
    assert(relative.startsWith('reply-clock-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const message = (id, text) => ({ id, serverMessageId: id, direction: 'incoming', chatType: 'private', peerId: 'clock-fixture-user',
    sender: { id: 'clock-fixture-user', nickname: '合成成员' }, time: Math.floor(at / 1000), message: [{ type: 'text', data: { text } }] });
  channel.receive(message('first', '第一条'), account.id); await entered.promise;
  channel.receive(message('second', '第二条'), account.id);
  at = Date.parse('2026-11-19T00:00:10+08:00');
  gate.resolve(); await channel.whenIdle();
  assert.deepEqual(clocks, [{ timeZone: 'Asia/Shanghai', currentTime: '2026-11-19T00:00:10+08:00', currentDayPeriod: '凌晨', messageTime: '2026-11-18T23:59:50+08:00' }]);
});
