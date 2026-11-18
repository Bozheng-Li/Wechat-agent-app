import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJson } from "../../backend/storage/atomic-json.ts";
import { ChannelError, schedulesEnabled } from "../../shared/contracts.mjs";
import { assertConversationAuthorized, assertPersonAuthorized, conversationAuthorized } from '../../shared/authorization.mjs';

const clone = (value) => structuredClone(value);
const active = new Set(['pending', 'running']);
const MAX_TASK_TARGETS = 20;
// A failing one-off task used to retry every minute for ever; keep a bounded
// budget with exponential backoff, then pause it for the owner to inspect.
const MAX_RETRY_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
// The run log is append-only; a 1-minute interval task would otherwise grow
// schedules.json by half a million rows a year.
const MAX_RUNS = 2000;
// A single failed save — a transient disk error on Windows — used to stop the
// scheduler for ever and leave every pending task without a runner.
const MAX_SCHEDULER_FAILURES = 5;
// Finished tasks had no retention at all: a one-off reminder a day left a row a
// day in schedules.json for ever.
const MAX_FINISHED_TASKS = 500;
const FINISHED_TASK_AGE_MS = 30 * 86400000;
const FINISHED_TASK_STATES = new Set(['completed', 'cancelled']);
const memberId = (value) =>
  typeof value === 'string' &&
  /^[\w@.:-]{1,256}$/.test(value) &&
  !value.endsWith('@chatroom') &&
  !/^(?:all|@all|notify@all)$/i.test(value);
const memberName = (value) =>
  typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const searchName = (value) =>
  String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/^@/, '')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('zh-CN');
const everyoneName = (value) => /^(?:all|notify@all|所有人|全体成员|全体|大家|我们)$/i.test(searchName(value));
function savedTargets(value, scope) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TASK_TARGETS)
    throw new ChannelError('INVALID_TASK_TARGET', '每个任务最多选择 20 位提醒对象');
  if (value.length && scope.chatType !== 'group')
    throw new ChannelError('TASK_TARGET_GROUP_ONLY', '真正 @ 只支持群聊；私聊任务不需要选择提醒对象');
  const targets = new Map();
  for (const target of value) {
    if (
      !target ||
      typeof target !== 'object' ||
      Array.isArray(target) ||
      !memberId(target.id) ||
      !memberName(target.name)
    )
      throw new ChannelError('INVALID_TASK_TARGET', '提醒对象必须是已核对的群成员，请重新按名称选择；不支持 @所有人');
    targets.set(target.id, { id: target.id, name: target.name.trim() });
  }
  return [...targets.values()];
}
export function nextDaily(time, after, timeZone = 'Asia/Shanghai') {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ChannelError('INVALID_TASK', '每日时间请填写 00:00–23:59');
  let format;
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new ChannelError('INVALID_TASK', '任务时区无效');
  }
  const parts = (stamp) =>
    Object.fromEntries(
      format
        .formatToParts(new Date(stamp))
        .filter((value) => value.type !== 'literal')
        .map((value) => [value.type, Number(value.value)])
    );
  const local = parts(after),
    [hour, minute] = time.split(':').map(Number);
  for (let day = 0; day < 3; day++) {
    const localUtc = Date.UTC(local.year, local.month - 1, local.day + day, hour, minute);
    let candidate = localUtc;
    for (let retry = 0; retry < 3; retry++) {
      const actual = parts(candidate),
        actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
      candidate += localUtc - actualUtc;
    }
    if (candidate > after) return candidate;
  }
  throw new ChannelError('INVALID_TASK', '无法计算任务的下一次执行时间');
}
export function validateSchedule(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ChannelError('INVALID_TASK', '请选择执行时间');
  if (value.kind === 'once') {
    if (!Number.isSafeInteger(value.at) || value.at <= now || value.at > now + 366 * 86400000)
      throw new ChannelError('INVALID_TASK', '一次性任务应安排在未来一年内');
    return { kind: 'once', at: value.at };
  }
  if (value.kind === 'interval') {
    if (!Number.isInteger(value.minutes) || value.minutes < 1 || value.minutes > 525600)
      throw new ChannelError('INVALID_TASK', '重复间隔应为 1–525600 分钟');
    return { kind: 'interval', minutes: value.minutes };
  }
  if (value.kind === 'daily') {
    nextDaily(value.time, now, value.timeZone || 'Asia/Shanghai');
    return { kind: 'daily', time: value.time, timeZone: value.timeZone || 'Asia/Shanghai' };
  }
  throw new ChannelError('INVALID_TASK', '请选择一次性、每天或间隔执行');
}
export function scheduleNext(schedule, after) {
  return schedule.kind === 'once'
    ? schedule.at
    : schedule.kind === 'interval'
      ? after + schedule.minutes * 60000
      : nextDaily(schedule.time, after, schedule.timeZone);
}

export class TaskScheduler {
  constructor({ store, channel, now = Date.now, retryMs = 60000 }) {
    Object.assign(this, { store, channel, now, retryMs });
    this.file = path.join(store.root, 'storage/tasks/schedules.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new ChannelError('TASKS_INVALID', '定时任务文件无法读取，已停止调度，请保留文件并检查权限');
    }
    this.data ??= { version: 1, ownerStoreId: store.data.storeId, tasks: [], runs: [] };
    if (
      this.data.version !== 1 ||
      this.data.ownerStoreId !== store.data.storeId ||
      !Array.isArray(this.data.tasks) ||
      !Array.isArray(this.data.runs)
    )
      throw new ChannelError('TASKS_INVALID', '定时任务数据格式或归属有误，未执行任务');
    for (const task of this.data.tasks) {
      try {
        task.targets = savedTargets(task.targets, task);
      } catch {
        throw new ChannelError('TASKS_INVALID', '定时任务中的提醒对象无效，已停止调度；请保留文件并核对任务数据');
      }
    }
    for (const task of this.data.tasks)
      if (task.state === 'running') {
        const record = store.data.records.find((record) => record.key === task.recordKey);
        const sent = record?.state === 'sent',
          uncertain =
            (record?.sendAttempted && !['rejected', 'not-sent'].includes(record?.delivery)) ||
            ['sending', 'unknown', 'partial'].includes(record?.state) ||
            record?.acknowledgedMessageIds?.length;
        task.state = sent
          ? task.schedule.kind === 'once'
            ? 'completed'
            : 'pending'
          : uncertain
            ? 'paused'
            : 'pending';
        if (sent && task.schedule.kind !== 'once') task.nextRunAt = scheduleNext(task.schedule, now());
        // A pre-send interruption is retried right away, so the attempt "failed";
        // recording it as "cancelled" told the owner their reminder was dropped.
        task.lastState = sent ? 'sent' : uncertain ? 'unknown' : 'failed';
        task.lastError = sent
          ? null
          : uncertain
            ? '上次发送结果不明，已暂停，请先在微信核对'
            : '上次在发送前中断，等待恢复后提醒';
        const run = this.data.runs.find((run) => run.id === task.runId);
        if (run)
          Object.assign(run, {
            state: task.lastState,
            finishedAt: now(),
            reason: task.lastError,
            acknowledgedMessageIds: record?.acknowledgedMessageIds || [],
          });
      }
    this.save();
    channel.scheduler = this;
    channel.authorization?.reconcile();
  }
  save() {
    this.pruneRuns();
    try {
      atomicJson(this.file, this.data);
    } catch {
      throw new ChannelError('STATE_WRITE_FAILED', '定时任务状态未能保存，已停止本次调度，请检查磁盘和目录权限');
    }
  }
  pruneRuns() {
    const runs = this.data.runs;
    if (!Array.isArray(runs)) return;
    if (runs.length > MAX_RUNS) {
      const referenced = new Set(this.data.tasks.map((task) => task.runId).filter(Boolean));
      const newest = new Set(runs.slice(-MAX_RUNS).map((run) => run.id));
      this.data.runs = runs.filter((run) => newest.has(run.id) || referenced.has(run.id));
    }
    // Finished tasks used to stay for ever, so an account that fires a one-off
    // reminder every day grew a row a day. Keep the newest ones (and the runs
    // they still cite) and drop the old rows the owner can no longer act on.
    const tasks = this.data.tasks;
    if (!Array.isArray(tasks) || !tasks.length) return;
    const runIds = new Set(this.data.runs.map((run) => run.id));
    const cutoff = this.now() - FINISHED_TASK_AGE_MS;
    const finished = tasks
      .filter((task) => FINISHED_TASK_STATES.has(task.state))
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    const dropped = new Set(
      finished
        .filter(
          (task, index) =>
            index >= MAX_FINISHED_TASKS ||
            ((task.updatedAt || task.createdAt || 0) < cutoff && !(task.runId && runIds.has(task.runId)))
        )
        .map((task) => task.id)
    );
    if (dropped.size) this.data.tasks = tasks.filter((task) => !dropped.has(task.id));
  }
  authorized(selector, fromChat = false) {
    assertConversationAuthorized(this.store, selector);
    for (const target of selector.targets || []) assertPersonAuthorized(this.store, selector.accountId, target.id);
    const settings = this.store.settings(selector.accountId);
    if (!schedulesEnabled(settings))
      throw new ChannelError('TASK_NOT_AUTHORIZED', '定时任务已在自动功能中关闭，未执行本次任务');
    if (!conversationAuthorized(this.store, selector))
      throw new ChannelError('TASK_NOT_AUTHORIZED', '该会话未授权，未执行定时任务');
    if (
      fromChat &&
      this.store.conversationSettings(selector.accountId, selector.chatType, selector.peerId).allowChatTasks === false
    )
      throw new ChannelError('TASK_NOT_AUTHORIZED', '管理员已关闭这个会话的聊天定时任务');
  }
  async resolveTargets(value, scope, signal) {
    if (value === undefined || (Array.isArray(value) && !value.length)) return [];
    if (!Array.isArray(value) || value.length > MAX_TASK_TARGETS)
      throw new ChannelError('INVALID_TASK_TARGET', '每个任务最多选择 20 位提醒对象');
    if (scope.chatType !== 'group' || typeof scope.peerId !== 'string' || !scope.peerId.endsWith('@chatroom'))
      throw new ChannelError('TASK_TARGET_GROUP_ONLY', '真正 @ 只支持群聊；私聊任务不需要选择提醒对象');
    const requests = value.map((target) => {
      if (typeof target === 'string') target = { name: target };
      if (
        !target ||
        typeof target !== 'object' ||
        Array.isArray(target) ||
        (target.id !== undefined && !memberId(target.id)) ||
        (target.id === undefined && (!memberName(target.name) || !searchName(target.name) || everyoneName(target.name)))
      )
        throw new ChannelError('INVALID_TASK_TARGET', '请按群成员名称选择提醒对象；不支持 @所有人');
      return target.id === undefined ? { name: target.name.trim() } : { id: target.id };
    });
    const assertScope = () => {
      signal?.throwIfAborted();
      this.authorized(scope, scope.source === 'chat');
      const current = this.channel.transport.status();
      if (current.account?.id !== scope.accountId)
        throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，未读取其他账号的群成员');
      if (!current.online)
        throw new ChannelError('TASK_MEMBERS_UNAVAILABLE', '微信当前离线，无法核对提醒对象；尚未创建或发送提醒');
    };
    assertScope();
    if (typeof this.channel.transport.call !== 'function')
      throw new ChannelError('TASK_MEMBERS_UNAVAILABLE', '当前微信组件无法读取群成员，尚未创建或发送 @ 提醒');
    const response = await this.channel.transport.call(
      'members',
      { accountId: scope.accountId, peerId: scope.peerId },
      { signal }
    );
    assertScope();
    if (
      response?.accountId !== scope.accountId ||
      response?.peerId !== scope.peerId ||
      !Array.isArray(response.members)
    )
      throw new ChannelError('TASK_MEMBERS_UNAVAILABLE', '群成员名单的账号或会话不匹配，尚未创建或发送 @ 提醒');
    const members = new Map();
    for (const member of response.members) {
      if (!member || !memberId(member.id) || (member.groupId !== undefined && member.groupId !== scope.peerId))
        continue;
      const names = [member.card, member.nickname, member.name, member.remark, member.alias].filter(memberName);
      const name = names[0]?.trim() || member.id;
      members.set(member.id, { id: member.id, name, names: new Set([...names, member.id].map(searchName)) });
    }
    const targets = new Map();
    for (const request of requests) {
      let matches;
      if (request.id) matches = members.has(request.id) ? [members.get(request.id)] : [];
      else {
        const query = searchName(request.name),
          all = [...members.values()];
        const exact = all.filter((member) => member.names.has(query));
        matches = exact.length ? exact : all.filter((member) => [...member.names].some((name) => name.includes(query)));
      }
      if (!matches.length)
        throw new ChannelError(
          'TASK_TARGET_NOT_FOUND',
          request.id
            ? '提醒对象已不在当前群的已同步成员名单中，尚未创建或发送 @ 提醒；请重新核对成员'
            : `已同步群成员中找不到“${request.name}”，请核对群昵称；尚未创建或发送 @ 提醒`
        );
      if (matches.length > 1)
        throw new ChannelError(
          'TASK_TARGET_AMBIGUOUS',
          `“${request.name}”匹配到 ${matches.length} 位群成员，请提供更完整的群昵称，或在当前消息中真正 @ 目标成员`,
          { candidates: matches.map(({ id, name }) => ({ id, name })) }
        );
      const { id, name } = matches[0];
      targets.set(id, { id, name });
    }
    return [...targets.values()];
  }
  create(input, scope) {
    this.authorized(scope, scope.source === 'chat');
    // This key is supplied only by a trusted owner workflow, never tool arguments.
    // Retrying the same confirmed todo must find its task even if the first
    // summary write failed and the retry asks for a different time or wording.
    const operationKey =
      scope.source === 'owner' && scope.operationKey
        ? createHash('sha256')
            .update(JSON.stringify([scope.accountId, scope.chatType, scope.peerId, scope.operationKey]))
            .digest('hex')
        : null;
    if (operationKey) {
      const previous = this.data.tasks.find(
        (task) =>
          task.operationKey === operationKey &&
          task.accountId === scope.accountId &&
          task.chatType === scope.chatType &&
          task.peerId === scope.peerId
      );
      if (previous) return clone(previous);
    }
    if (
      !['message', 'agent'].includes(input.kind) ||
      typeof input.content !== 'string' ||
      !input.content.trim() ||
      input.content.length > 4000 ||
      /\u0000/.test(input.content)
    )
      throw new ChannelError('INVALID_TASK', '请选择发送消息或执行 Agent 任务，并填写 1–4000 字的内容');
    const targets = savedTargets(input.targets, scope);
    for (const target of targets) assertPersonAuthorized(this.store, scope.accountId, target.id);
    const identity = [
      scope.accountId,
      scope.chatType,
      scope.peerId,
      scope.requestKey,
      scope.senderId,
      input.kind,
      input.content.trim(),
      input.schedule,
    ];
    if (targets.length) identity.push(targets.map((target) => target.id).sort());
    const requestKey = scope.requestKey ? createHash('sha256').update(JSON.stringify(identity)).digest('hex') : null;
    if (requestKey) {
      const previous = this.data.tasks.find((task) => task.requestKey === requestKey);
      if (previous) return clone(previous);
    }
    // A dead scheduler would never pick the task up, so a "successful" creation
    // would only pile up reminders that never run. `stopped` alone cannot be the
    // signal: it is also the initial state before start(), and chat/UI legitimately
    // create tasks during startup, so only a stop caused by repeated failures
    // refuses new work.
    if (this.failed) throw new ChannelError('TASKS_STOPPED', '定时任务已暂停，请重启应用后重新创建');
    const schedule = validateSchedule(input.schedule, this.now());
    if (this.data.tasks.filter((task) => task.accountId === scope.accountId && active.has(task.state)).length >= 100)
      throw new ChannelError('TASK_LIMIT', '当前账号最多保留 100 个活动任务，请先取消不再需要的任务');
    if (
      scope.source === 'chat' &&
      this.data.tasks.filter(
        (task) =>
          task.accountId === scope.accountId &&
          task.peerId === scope.peerId &&
          task.senderId === scope.senderId &&
          active.has(task.state)
      ).length >= 20
    )
      throw new ChannelError('TASK_LIMIT', '你在这个会话中已有 20 个活动任务，请先取消不再需要的任务');
    const task = {
      id: randomUUID(),
      accountId: scope.accountId,
      chatType: scope.chatType,
      peerId: scope.peerId,
      senderId: scope.senderId || scope.accountId,
      senderName: scope.senderName || '管理员',
      source: scope.source || 'owner',
      requestKey,
      ...(operationKey ? { operationKey } : {}),
      kind: input.kind,
      content: input.content.trim(),
      schedule,
      targets,
      nextRunAt: scheduleNext(schedule, this.now()),
      state: 'pending',
      createdAt: this.now(),
      updatedAt: this.now(),
      revision: 1,
      lastState: null,
      lastError: null,
    };
    this.data.tasks.push(task);
    try {
      this.save();
    } catch (error) {
      this.data.tasks.pop();
      throw error;
    }
    return clone(task);
  }
  get(id, scope, owner = false) {
    const task = this.data.tasks.find(
      (task) =>
        task.id === id &&
        task.accountId === scope.accountId &&
        (owner ||
          (task.chatType === scope.chatType && task.peerId === scope.peerId && task.senderId === scope.senderId))
    );
    if (!task) throw new ChannelError('TASK_NOT_FOUND', '任务不存在，或你不能管理这个任务');
    return task;
  }
  cancel(id, scope, owner = false) {
    const task = this.get(id, scope, owner),
      previous = clone(task);
    if (!['pending', 'paused', 'running'].includes(task.state))
      throw new ChannelError('TASK_CHANGED', '这个任务已经结束，无需再次取消');
    task.state = 'cancelled';
    task.updatedAt = this.now();
    task.revision++;
    try {
      this.save();
    } catch (error) {
      Object.assign(task, previous);
      throw error;
    }
    if (this.current?.task.id === id) {
      // The abort races a send that may already be on the wire: "cancelled"
      // here would claim nothing reached WeChat.
      const run = this.data.runs.find((value) => value.id === this.current.task.runId);
      if (run && !run.finishedAt) run.state = 'unknown';
      this.current.controller.abort(new ChannelError('CANCELLED', '定时任务已取消'));
    }
    return clone(task);
  }
  pause(id, scope) {
    const task = this.get(id, scope, true);
    if (task.state !== 'pending') throw new ChannelError('TASK_CHANGED', '只能暂停等待执行的任务');
    const previous = clone(task);
    task.state = 'paused';
    task.updatedAt = this.now();
    task.revision++;
    try {
      this.save();
    } catch (error) {
      Object.assign(task, previous);
      throw error;
    }
    return clone(task);
  }
  resume(id, scope) {
    const task = this.get(id, scope, true);
    this.authorized(task, task.source === 'chat');
    if (task.state !== 'paused' || ['unknown', 'partial'].includes(task.lastState))
      throw new ChannelError('TASK_CHANGED', '发送结果不明的任务不能直接重试，请在微信核对后另建任务');
    const previous = clone(task);
    task.state = 'pending';
    task.retryAt = null;
    delete task.attempts;
    task.revision++;
    task.updatedAt = this.now();
    try {
      this.save();
    } catch (error) {
      Object.assign(task, previous);
      throw error;
    }
    return clone(task);
  }
  list(accountId, selector) {
    const match = (task) =>
      task.accountId === accountId &&
      (!selector ||
        (task.peerId === selector.peerId &&
          task.chatType === selector.chatType &&
          (!selector.senderId || task.senderId === selector.senderId)));
    // conversations() builds a full view per conversation, so read it once for
    // the whole list instead of once per task.
    const names = new Map(
      this.store.conversations(accountId).map((peer) => [`${peer.chatType}\u0000${peer.peerId}`, peer.name])
    );
    const tasks = this.data.tasks
      .filter(match)
      .map((task) => ({
        ...clone(task),
        overdue: task.state === 'pending' && task.nextRunAt <= this.now(),
        name: names.get(`${task.chatType}\u0000${task.peerId}`) || task.peerId,
      }));
    const ids = new Set(tasks.map((task) => task.id));
    return {
      tasks: tasks.sort((a, b) => active.has(b.state) - active.has(a.state) || a.nextRunAt - b.nextRunAt),
      runs: this.data.runs
        .filter((run) => ids.has(run.taskId))
        .slice(-100)
        .reverse()
        .map(clone),
      error: this.error || null,
    };
  }
  start() {
    this.stopped = false;
    this.failed = false;
    this.failures = 0;
    // A run that stopped on an error left its interval alive: installing another
    // one points this.timer at the new handle and leaks the old 1 Hz timer.
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        // One failed save — a transient disk error on Windows — must not stop
        // the scheduler for ever: keep retrying, and only give up once every
        // round keeps failing.
        this.failures = (this.failures || 0) + 1;
        this.stopped = this.failures >= MAX_SCHEDULER_FAILURES;
        if (this.stopped) this.failed = true;
        this.error =
          error instanceof ChannelError
            ? error.message
            : this.stopped
              ? '任务调度异常，已停止自动执行'
              : '任务调度异常，稍后自动重试';
      });
    }, 1000);
    this.timer.unref?.();
  }
  async tick() {
    if (this.stopped || this.running) return;
    this.running = this.drain();
    try {
      await this.running;
      // A clean round means the failure streak is over. Only clear a message
      // this counter owns: other components also write to this.error.
      if (this.failures) {
        this.failures = 0;
        this.error = null;
      }
    } finally {
      this.running = null;
    }
  }
  async drain() {
    for (const task of this.data.tasks) {
      if (this.stopped || task.state !== 'pending' || task.nextRunAt > this.now() || task.retryAt > this.now())
        continue;
      const current = this.channel.transport.status();
      if (
        !current.online ||
        current.account?.id !== task.accountId ||
        [...this.channel.pauses.values()].some(
          (pause) =>
            !pause.selector ||
            ['accountId', 'chatType', 'peerId'].every(
              (key) => pause.selector[key] === undefined || pause.selector[key] === task[key]
            )
        )
      )
        continue;
      try {
        this.authorized(task, task.source === 'chat');
      } catch (error) {
        // Silently skipping left the task "overdue" forever with no explanation.
        const message = error instanceof ChannelError ? error.message : '任务目标未通过授权检查';
        if (task.lastError !== message) {
          task.lastError = message;
          this.save();
        }
        continue;
      }
      const controller = new AbortController(),
        id = randomUUID();
      const run = {
        id,
        taskId: task.id,
        accountId: task.accountId,
        scheduledAt: task.nextRunAt,
        startedAt: this.now(),
        state: 'queued',
        acknowledgedMessageIds: [],
      };
      const before = clone(task);
      task.state = 'running';
      task.runId = id;
      task.recordKey = 'scheduled:' + id;
      this.data.runs.push(run);
      try {
        this.save();
      } catch (error) {
        Object.assign(task, before);
        this.data.runs.pop();
        throw error;
      }
      this.current = { task, controller };
      try {
        const record = await this.channel.submitScheduled(clone(task), controller.signal);
        Object.assign(run, {
          state: record.state,
          reason: record.reason || null,
          acknowledgedMessageIds: record.acknowledgedMessageIds || [],
          taskFallback: record.taskFallback,
          finishedAt: this.now(),
        });
        task.lastState = record.state;
        task.lastError = record.reason || null;
        if (task.state === 'running') {
          if (record.state !== 'sent') {
            const safe =
              !record.acknowledgedMessageIds?.length &&
              !['unknown', 'partial'].includes(record.state) &&
              (!record.sendAttempted || ['rejected', 'not-sent'].includes(record.delivery));
            task.state = safe ? 'pending' : 'paused';
            if (safe) {
              const attempt = (task.attempts = (task.attempts || 0) + 1);
              if (attempt >= MAX_RETRY_ATTEMPTS) {
                task.state = 'paused';
                task.lastError = `${run.reason || '任务连续执行失败'}；已连续失败 ${attempt} 次并暂停，请检查目标后手动恢复`;
                delete task.retryAt;
              } else task.retryAt = this.now() + Math.min(this.retryMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
              if (record.replyDraft) {
                task.retryText = record.replyDraft;
                task.retryAsset = record.replyMedia;
              }
            }
          } else if (task.schedule.kind === 'once') task.state = 'completed';
          else {
            task.state = 'pending';
            // Advance from the scheduled slot, not from "now": otherwise a task
            // that takes 40s to run drifts by 40s on every single round.
            let next = scheduleNext(task.schedule, task.nextRunAt ?? this.now());
            if (task.schedule.kind === 'interval') {
              const interval = task.schedule.minutes * 60000;
              // Land strictly in the future: "due right now" would run the same
              // minute twice after a long downtime.
              if (next <= this.now() && interval > 0) next += (Math.floor((this.now() - next) / interval) + 1) * interval;
            } else for (let guard = 0; next <= this.now() && guard < 512; guard++) next = scheduleNext(task.schedule, next);
            task.nextRunAt = next;
          }
          if (record.state === 'sent') {
            delete task.retryAt;
            delete task.attempts;
            delete task.retryText;
            delete task.retryAsset;
          }
        }
      } catch (error) {
        const record = this.store.data.records.find((value) => value.key === task.recordKey);
        // Same evidence rule as the restart path: a send that was already on the
        // wire can have reached WeChat even though this call failed, so only a
        // confirmed unsent attempt may be recorded as "failed".
        const uncertain =
          !!record?.sendAttempted && !['rejected', 'not-sent'].includes(error?.details?.delivery ?? record?.delivery);
        Object.assign(run, {
          state: uncertain ? 'unknown' : 'failed',
          reason: uncertain
            ? '上次发送结果不明，请先在微信核对'
            : error instanceof ChannelError
              ? error.message
              : '任务执行失败，请检查处理记录',
          finishedAt: this.now(),
        });
        task.lastState = run.state;
        task.lastError = run.reason;
        if (task.state === 'running') {
          const attempt = (task.attempts = (task.attempts || 0) + 1);
          if (record?.sendAttempted || attempt >= MAX_RETRY_ATTEMPTS) {
            task.state = 'paused';
            if (attempt >= MAX_RETRY_ATTEMPTS && !record?.sendAttempted)
              task.lastError = `${run.reason}；已连续失败 ${attempt} 次并暂停，请检查目标后手动恢复`;
            delete task.retryAt;
          } else {
            task.state = 'pending';
            task.retryAt = this.now() + Math.min(this.retryMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
          }
        }
      } finally {
        task.updatedAt = this.now();
        this.current = null;
        this.save();
      }
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.current?.controller.abort(new ChannelError('CANCELLED', '插件正在停止，定时任务已中止'));
    await this.running;
  }
}

function chineseNumber(value) {
  if (/^\d+(?:\.5)?$/.test(value)) return Number(value);
  if (value === '半') return 0.5;
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0 };
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [left, right] = value.split('十');
    return (digits[left] || 1) * 10 + (digits[right] || 0);
  }
  return digits[value] ?? NaN;
}
export function simpleReminder(text, names, now) {
  let normalized = String(text).trim();
  if (/(?:顺便|同时|再|并且|然后).{0,20}(?:发|表情|图片)/u.test(normalized)) return null;
  if (/(?:提醒我|叫我)\s*(?:和|、|以及|跟(?!进|踪|上|着|随))/u.test(normalized)) return null;
  for (const name of [...names].filter(Boolean).sort((a, b) => b.length - a.length))
    if (normalized.startsWith(name)) {
      normalized = normalized.slice(name.length).replace(/^[，,：:\s]+/, '');
      break;
    }
  const match =
    /^(?:请|帮我|请帮我|麻烦你|请你|能不能)?\s*(?:在|过)?\s*([\d.一二两三四五六七八九十半]+)\s*个?\s*(秒钟?|分钟?|小时|天)(?:之|以)?后(?:请)?(提醒大家|提醒我们|提醒我|叫我)([^\r\n]{1,500})[。！!]?$/u.exec(
      normalized
    );
  if (!match) return null;
  const amount = chineseNumber(match[1]),
    multiplier = match[2].startsWith('秒')
      ? 1000
      : match[2].startsWith('分')
        ? 60000
        : match[2] === '小时'
          ? 3600000
          : 86400000;
  if (!Number.isFinite(amount) || amount <= 0 || amount * multiplier > 366 * 86400000) return null;
  return {
    kind: 'message',
    content: '到点啦，别忘了' + match[4].replace(/[。！!]+$/, '').trim() + '。',
    audience: /大家|我们/u.test(match[3]) ? 'everyone' : 'sender',
    delayLabel: match[1] + match[2],
    schedule: { kind: 'once', at: Math.trunc(now + amount * multiplier) },
  };
}
