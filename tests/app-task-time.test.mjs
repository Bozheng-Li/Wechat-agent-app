import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTaskTool } from '../modules/tasks/conversation-tools.mjs';

function fixture() {
  const saved = [], now = Date.parse('2026-11-12T09:00:00Z');
  const scheduler = { now: () => now, authorized() {}, resolveTargets: async () => [],
    create(input) { saved.push(input); return { ...input, id: 'test-task', nextRunAt: input.schedule.at }; } };
  const tool = conversationTaskTool(scheduler, { accountId: 'synthetic-owner', chatType: 'private', peerId: 'alice', senderId: 'alice' }, () => {}, '请在 2026-11-12T10:46:19.881Z 提醒我检查咖啡');
  const invoke = at => tool.execute({ action: 'create', kind: 'message', content: '检查咖啡', at }, { signal: new AbortController().signal }).then(JSON.parse);
  return { saved, invoke };
}

test('ISO millisecond timestamps keep the exact instant for UTC and explicit offsets', async () => {
  const f = fixture();
  for (const at of ['2026-11-12T10:46:19.881Z', '2026-11-12T18:46:19.881+08:00']) {
    const result = await f.invoke(at); assert.equal(result.ok, true); assert.equal(result.task.nextRunAt, '2026-11-12T10:46:19.881Z');
  }
  assert.equal(f.saved.length, 2); assert.equal(f.saved[0].schedule.at, f.saved[1].schedule.at);
});

test('invalid dates and missing offsets never create a scheduled task', async () => {
  const f = fixture();
  for (const at of ['2026-11-12T10:46:19.881', '2026-02-30T10:00:00Z', '2026-11-12T24:00:00Z', '2026-11-12T10:70:00+08:00']) {
    assert.equal((await f.invoke(at)).ok, false, at);
  }
  assert.equal(f.saved.length, 0);
});
