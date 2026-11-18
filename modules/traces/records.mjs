import { createHash } from 'node:crypto';
import { traceSnippet, tracePayload } from './sanitize.mjs';
import { TRACE_ACTIVE, traceState } from '../../shared/execution-traces.mjs';
import { ChannelError } from '../../shared/contracts.mjs';

export function recordType(record) {
  if (record.recoveryOf) return 'maintenance';
  if (record.mode?.includes('moments')) return 'moments';
  if (record.mode?.includes('sticker') || record.mode?.includes('image')) return 'media';
  if (record.mode?.includes('digest')) return 'digest';
  if (record.mode === 'scheduled' || record.taskId) return 'scheduled';
  return 'conversation';
}
export function recordState(record) {
  if (record.state === 'queued') return 'queued';
  if (['generating', 'sending', 'running'].includes(record.state)) return 'running';
  if (['ignored', 'skipped'].includes(record.state)) return 'skipped';
  return traceState(record);
}
export const recordInput = record => ({ question: record.question, accountId: record.accountId, chatType: record.chatType,
  peerId: record.peerId, senderId: record.senderId, sender: record.sender, messageId: record.messageId, mode: record.mode,
  taskId: record.taskId, recoveryOf: record.recoveryOf });
export const recordOutput = record => ({ state: record.state, reply: record.reply, replyDraft: record.replyDraft, replyMedia: record.replyMedia,
  personaMode: record.personaMode, personaPasses: record.personaPasses,
  reason: record.reason, sentAt: record.sentAt, delivery: record.delivery, acknowledgedMessageIds: record.acknowledgedMessageIds,
  deliveryParts: record.deliveryParts, sessionId: record.sessionId, memoryReflection: record.memoryReflection, taskFallback: record.taskFallback });
export const recordSpec = record => ({ key: 'record:' + record.key, type: recordType(record), accountId: record.accountId,
  peerId: record.peerId, chatType: record.chatType, actor: record.sender || record.senderId, source: record.mode === 'scheduled' ? 'schedule' : 'chat',
  title: traceSnippet(record.question || (record.mode === 'scheduled' ? '定时执行' : '会话回复'), 100), createdAt: record.createdAt,
  input: recordInput(record), state: recordState(record),
  ...(recordState(record) === 'skipped' && record.reason ? { reason: record.reason } : {}) });
export function historicalTraces(channel) {
  const id = spec => 'history-' + createHash('sha256').update(spec.accountId + ':' + spec.key).digest('hex').slice(0, 32);
  const entries = accountId => (channel.store.data.records || []).filter(record => record.accountId === accountId && record.key).map(record => ({
    spec: recordSpec(record), state: recordState(record), output: recordOutput(record), startedAt: record.startedAt,
    finishedAt: TRACE_ACTIVE.has(recordState(record)) ? null : record.sentAt || record.updatedAt, metrics: record.requestMetrics,
  }));
  const summary = entry => ({ id: id(entry.spec), accountId: entry.spec.accountId, type: entry.spec.type, title: entry.spec.title,
    sourceKey: entry.spec.key, peerId: entry.spec.peerId, chatType: entry.spec.chatType, actor: traceSnippet(entry.spec.actor || '', 120),
    state: entry.state, createdAt: entry.spec.createdAt, startedAt: entry.startedAt || null, finishedAt: entry.finishedAt || null,
    durationMs: entry.finishedAt && entry.startedAt ? Math.max(0, entry.finishedAt - entry.startedAt) : null,
    reason: entry.state === 'skipped' ? traceSnippet(entry.output?.reason || '', 40) || undefined : undefined,
    updatedAt: entry.finishedAt || entry.spec.createdAt, coverage: 'historical', inputPreview: traceSnippet(entry.spec.input.question || entry.spec.input.request || ''),
    // Only model-call metrics survive in the record; tool steps were never
    // persisted, so the historical summary must not pretend to count them.
    modelCalls: entry.metrics?.length || 0, toolCalls: 0, note: '历史摘要：当时只保存了输入、结果和模型调用，未记录工具步骤。' });
  return {
    list: (accountId, { from, to, startAt = Date.parse(from), endAt = Date.parse(to) + 86400000 - 1 }) => entries(accountId).filter(entry => Number.isFinite(entry.spec.createdAt) &&
      entry.spec.createdAt >= startAt && entry.spec.createdAt <= endAt).map(summary),
    get: (accountId, traceId) => {
      const entry = entries(accountId).find(item => id(item.spec) === traceId);
      if (!entry) throw new ChannelError('TRACE_NOT_FOUND', '这条历史摘要不存在或不属于当前账号');
      // Nothing about individual tool calls was stored at the time, so the
      // detail view shows the saved input/output instead of invented steps.
      const steps = [];
      return { trace: { ...summary(entry), inputValue: tracePayload(entry.spec.input), outputValue: tracePayload(entry.output),
        historicalMetrics: tracePayload(entry.metrics || []) }, steps, total: steps.length, offset: 0, limit: steps.length };
    },
  };
}
