import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readPluginModels } from '../scripts/live-plugin-models.mjs';
import { CredentialStore } from '../backend/platform/credentials.mjs';
import { ModelProviders } from '../backend/platform/providers.mjs';
import { stickerPng } from './fixtures/stickers.mjs';
import { StateStore, AppAgentRunner, WechatChannel, TaskScheduler, AgentIdentity, LongTermMemory } from '../lib/testing.js';

// The entire WeChat transport in this test is below. No WorkerClient, protocol
// backend or production account is constructed. Every recipient is synthetic.
export async function runLiveCases({ dataRoot, encryption, only, reuseImage = false }) {
  const borrowed = readPluginModels(), accountId = 'app-live-synthetic-owner';
  const root = path.join(dataRoot, 'profile'), scope = { accountId, chatType: 'private', peerId: 'alice', senderId: 'alice' };
  const report = { startedAt: new Date().toISOString(), completed: false, model: borrowed.selection,
    visionModel: borrowed.modelConfig.visionModel, modelTransport: 'direct API /chat/completions via Electron system networking',
    profile: root, actualWechatMessages: 0, notificationsSent: 0, wechatTransport: 'synthetic messages and server acknowledgments',
    cases: [], modelCalls: [], tools: [], sends: [], momentsReads: [], momentsWrites: [] };
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync('artifacts', { recursive: true });
  const reportPath = path.resolve('artifacts/live-chain-report' + (only ? '-' + only.join('-') : '') + (reuseImage ? '-recovery' : '') + '.json');
  const persist = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  persist();
  const credentials = new CredentialStore(root, encryption), providers = new ModelProviders(root, credentials);
  for (const { provider, apiKey } of borrowed.providers) await providers.save(provider, apiKey);
  if (borrowed.searchKey) await credentials.set('WECHAT_AGENT_TAVILY_API_KEY', borrowed.searchKey);
  for (const [name, value] of Object.entries(borrowed.imageCredentials)) await credentials.set(name, value);
  let store = new StateStore(root), clockOffset = 0, sequence = 0, ackGate;
  const receiptPrefix = 'synthetic-ack-' + randomUUID().slice(0, 8) + '-';
  const now = () => Date.now() + clockOffset;
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: ['live-room@chatroom'], prompt: '' });
  store.setModelChoice(borrowed.selection);
  store.setModelConfig({ ...borrowed.modelConfig, webSearch: false });
  store.setPersona({ name: '小胖', aliases: ['胖胖'], prompt: '说话自然简短，准确使用已提供的信息。' });
  const roles = store.roleCardSettingsView();
  store.setRoleCardSettings({ ...roles.settings, enabled: false }, roles.revision);
  const settings = store.config.snapshot(store.data);
  settings.remote = { globalAdminIds: ['alice'] };
  settings.imageGeneration = borrowed.imageGeneration;
  store.config.commit(settings);
  store.setConversationSettings(accountId, 'private', 'alice', { ...store.conversationSettings(accountId, 'private', 'alice'), remoteEnabled: true });
  const ctx = { credentials, llm: providers, agentDefaultModel: { currentSelection: () => borrowed.selection }, capabilities: { vision: true, webSearch: true, nativeWork: false } };
  const status = { online: true, state: 'online', account: { id: accountId, nickname: '本地验收账号' }, momentsReadReady: true, momentsWriteReady: true, momentsAudienceReady: true };
  const png = stickerPng([235, 30, 30], 100, 100);
  const audience = () => ({ accountId, membershipComplete: true, unavailableCount: 0, source: 'wechat-contacts-live', fetchedAt: new Date(now()).toISOString(),
    contacts: ['alice', 'bob'].map(id => ({ id, name: id, nickname: id, labelIds: [] })), labels: [] });
  const transport = {
    status: () => structuredClone(status),
    send: async payload => {
      assert.equal(payload.accountId, accountId); assert(['alice', 'bob', 'live-room@chatroom'].includes(payload.peerId));
      const id = receiptPrefix + (report.sends.length + 1);
      const deliveryParts = payload.message.filter(part => part.type !== 'at').map((part, index) => {
        const bytes = Buffer.from(part.data.base64 || '', 'base64');
        return { index, type: part.type, state: 'acknowledged', serverMessageId: index ? id + '-' + index : id,
          ...(part.type === 'text' ? {} : { name: part.data.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) };
      });
      report.sends.push({ id, peerId: payload.peerId, message: payload.message.map(part => ({ type: part.type,
        ...(part.type === 'text' ? { text: part.data.text } : { bytes: Buffer.from(part.data.base64 || '', 'base64').length }) })) });
      if (ackGate) { const gate = ackGate; ackGate = null; gate.reached.resolve(); await gate.release.promise; }
      return { delivery: 'server-ack', serverMessageIds: deliveryParts.map(part => part.serverMessageId), deliveryParts };
    },
    readMomentsAudience: async () => audience(),
    readMoments: async ({ accountId: requested, query }, signal) => {
      assert.equal(requested, accountId); signal?.throwIfAborted(); report.momentsReads.push(structuredClone(query));
      const published = report.momentsWrites.find(row => row.postId === query.postId);
      return { accountId, source: 'wechat-sns-live', action: query.action, ...(query.userId ? { userId: query.userId } : {}),
        ...(query.postId ? { postId: query.postId } : {}), items: [{ id: query.postId || '9007199254740997', author: { userId: query.userId || accountId },
          text: published?.text || '今天去青藤公园散步，看到湖边有两只鸭子。', imageCount: 0, createdAt: Math.floor(now() / 1000), contentAvailable: true, deleted: false }], nextCursor: null, mediaContentIncluded: false };
    },
    writeMoments: async ({ accountId: requested, query }, signal) => {
      assert.equal(requested, accountId); signal?.throwIfAborted();
      const postId = query.postId || String(9007199254740999n + BigInt(report.momentsWrites.length));
      report.momentsWrites.push({ ...query, postId, images: query.images?.map(() => '[synthetic attachment]') });
      return { accountId, action: query.action, postId, text: query.text, imageCount: query.images?.length || 0, delivery: 'server-ack',
        audienceConfirmed: true, authorizationConfirmed: true, authorizationExcludedCount: 0,
        authorizedAudienceUserIds: ['alice', 'bob'], audienceSource: 'wechat-contacts-live', audienceFetchedAt: audience().fetchedAt,
        audienceSelection: { blockedLabelIds: [], blockedUserIds: [] }, blockedLabelIds: [], blockedUserIds: [] };
    },
  };
  const runner = new AppAgentRunner(ctx, () => store.modelChoice(), () => ({ persona: store.persona(), modelConfig: store.modelConfig(),
    timeSettings: store.config.section('timeSettings'), workspacePath: store.ensureWorkspace(), identityMarkdown: new AgentIdentity(root, { config: store.config }).view().markdown }));
  const actualRun = runner.run.bind(runner);
  runner.run = async input => {
    const item = { mode: input.mode || 'default', input: input.text, startedAt: new Date().toISOString() }; report.modelCalls.push(item);
    console.log('  model ' + item.mode + ' #' + report.modelCalls.length);
    try {
      const result = await actualRun({ ...input, signal: AbortSignal.any([input.signal || new AbortController().signal, AbortSignal.timeout(240000)]),
        onBeforeTool: async (name, args, execution) => { report.tools.push({ name, args, mode: item.mode }); await input.onBeforeTool?.(name, args, execution); },
      });
      item.text = result.text; item.metrics = result.requestMetrics; return result;
    } catch (error) { item.error = { code: error.code, message: error.message }; throw error; }
    finally { item.finishedAt = new Date().toISOString(); persist(); }
  };
  let channel = new WechatChannel({ store, runner, transport, now }), scheduler = new TaskScheduler({ store, channel, now }); channel.scheduler = scheduler;
  const signal = () => AbortSignal.timeout(240000);
  const message = (text, peerId = 'alice') => { const id = 'synthetic-message-' + ++sequence; return { id, serverMessageId: id,
    direction: 'incoming', time: Math.floor(now() / 1000), chatType: 'private', peerId, sender: { id: peerId, nickname: peerId === 'alice' ? '阿宁' : peerId },
    message: [{ type: 'text', data: { text } }] }; };
  const receive = async text => {
    const input = message(text); channel.receive(input, accountId); await channel.whenIdle();
    const record = store.data.records.find(row => row.messageId === input.id);
    assert.equal(record?.state, 'sent', JSON.stringify({ state: record?.state, reason: record?.reason }));
    return { input, record };
  };
  const runCase = async (id, action) => {
    if (only && !only.includes(id)) return;
    const row = { id, state: 'running', startedAt: new Date().toISOString() }; report.cases.push(row); persist(); console.log('LIVE ' + id);
    try { row.evidence = await action(); row.state = 'passed'; }
    catch (error) { row.state = 'failed'; row.error = { code: error.code, message: error.message, stack: error.stack?.split('\n').slice(0, 5).join('\n') }; }
    row.finishedAt = new Date().toISOString(); persist(); console.log(row.state.toUpperCase() + ' ' + id + (row.error ? ': ' + row.error.message : ''));
  };
  let firstInput;
  try {
    await runCase('chat_ack', async () => {
      const gate = { reached: Promise.withResolvers(), release: Promise.withResolvers() }; ackGate = gate;
      firstInput = message('你好，我叫阿宁。喝咖啡时我只加燕麦奶。请简短回复一句。');
      channel.receive(firstInput, accountId);
      const idle = channel.whenIdle();
      try {
        await Promise.race([gate.reached.promise, idle.then(() => { throw Error('Reply ended before sending: ' + JSON.stringify(store.data.records.at(-1)?.reason)); })]);
        const record = store.data.records.find(row => row.messageId === firstInput.id); assert.equal(record.state, 'sending');
        assert.equal(store.history(accountId, 'private', 'alice').filter(row => row.direction === 'outgoing').length, 0);
      } finally { gate.release.resolve(); }
      await idle;
      const record = store.data.records.find(row => row.messageId === firstInput.id); assert.equal(record.state, 'sent');
      assert.deepEqual(record.acknowledgedMessageIds, [report.sends[0].id]);
      return { reply: record.reply, receipt: record.acknowledgedMessageIds, observedSendingBeforeAck: true };
    });
    await runCase('memory_extract', async () => {
      await channel.longMemory.extract(scope, runner, signal());
      const facts = channel.longMemory.view(accountId).sections.flatMap(row => row.facts);
      assert(facts.some(row => row.text.includes('燕麦奶')), 'The real extraction did not persist the source-backed preference');
      return { facts: facts.map(row => row.text) };
    });
    await runCase('memory_recall', async () => {
      const start = report.tools.length;
      const { record } = await receive('请调用记忆检索工具，查一下我喝咖啡时加什么奶，再告诉我结果。');
      assert(record.reply.includes('燕麦奶')); assert(report.tools.slice(start).some(tool => tool.name === 'wechat_memory'));
      return { reply: record.reply, tools: report.tools.slice(start).map(tool => tool.name) };
    });
    await runCase('role_card', async () => {
      channel.personMemory.request({ accountId, personId: 'alice' }, { manual: true });
      await channel.personMemory.whenIdle();
      const card = store.roleCards.view({ accountId, personId: 'alice' });
      assert(JSON.stringify(card.card).includes('燕麦奶'), JSON.stringify({ card: card.card, error: card.error }));
      return { card: card.card };
    });
    await runCase('vision', async () => {
      const description = await runner.describeImage({ mediaType: 'image/png', data: png.toString('base64') }, signal(), { question: '这张图片主要是什么颜色？' });
      assert(/红|red/i.test(description)); return { description, model: borrowed.modelConfig.visionModel };
    });
    await runCase('image_reply', async () => {
      const imported = channel.library.import(accountId, { name: '红色方块.png', kind: 'image', data: png.toString('base64') });
      channel.library.edit(accountId, imported.assetIds[0], { description: '红色方块测试图片', tags: ['红色', '方块'] });
      channel.library.configure(accountId, { enabled: true, probability: 100, minGapMessages: 0 });
      const start = report.sends.length; await receive('请从图片库里找那张红色方块图片并发给我。');
      assert(report.sends.slice(start).some(row => row.message.some(part => part.type === 'image')));
      return { messages: report.sends.slice(start), imageBytes: png.length };
    });
    await runCase('schedule_tools', async () => {
      const start = scheduler.list(accountId).tasks.length, at = new Date(now() + 3600000).toISOString();
      const { record } = await receive('请创建一次性定时提醒，在 ' + at + ' 提醒我检查咖啡有没有加燕麦奶。');
      const tasks = scheduler.list(accountId).tasks; assert(tasks.length > start, record.reply);
      return { reply: record.reply, tasks: tasks.map(row => ({ id: row.id, kind: row.kind, state: row.state, schedule: row.schedule })) };
    });
    await runCase('schedule_run', async () => {
      const task = scheduler.create({ kind: 'agent', content: '根据阿宁的咖啡偏好，提醒她检查杯子里加的奶。简短说一句。', schedule: { kind: 'once', at: now() + 1000 } }, scope);
      clockOffset += 1500; await scheduler.tick(); await channel.whenIdle();
      const result = scheduler.list(accountId).tasks.find(row => row.id === task.id); assert.equal(result.state, 'completed');
      const record = store.data.records.find(row => row.taskId === task.id); assert.equal(record.state, 'sent'); assert(record.reply.includes('燕麦奶'));
      return { state: result.state, reply: record.reply, receipt: record.acknowledgedMessageIds };
    });
    await runCase('web_search', async () => {
      store.setModelConfig({ ...borrowed.modelConfig, webSearch: true });
      const start = report.tools.length; const { record } = await receive('请联网搜索 Python 官方教程，给我官方教程的链接，不需要额外介绍。');
      assert(report.tools.slice(start).some(row => row.name === 'wechat_web_search')); assert(/https?:\/\/[^\s]*python\.org/i.test(record.reply), record.reply);
      return { reply: record.reply, search: runner.searchStatus() };
    });
    await runCase('moments_read', async () => {
      const start = report.momentsReads.length; const { record } = await receive('请实际读取我最近的一条朋友圈，告诉我里面提到了哪个公园。');
      assert(report.momentsReads.length > start); assert(record.reply.includes('青藤公园'), record.reply);
      return { reply: record.reply, reads: report.momentsReads.slice(start) };
    });
    await runCase('moments_publish', async () => {
      const manager = channel.momentsAutomation.publishing;
      const draft = await manager.preview(accountId, { themes: ['下雨天读书的小笑话'], maxChars: 200, image: { mode: 'none' }, useMaterials: false }, 'live-' + randomUUID(), signal());
      assert.equal(draft.state, 'draft'); const before = report.momentsWrites.length;
      await manager.publishDraft(accountId, draft.id, signal());
      const published = manager.list(accountId).runs.find(row => row.id === draft.id);
      assert.equal(published.state, 'published'); assert.equal(report.momentsWrites.length, before + 1);
      return { text: published.text, state: published.state, submissionCount: report.momentsWrites.length - before };
    });
    await runCase('local_work', async () => {
      store.setConversationSettings(accountId, 'private', 'alice', { ...store.conversationSettings(accountId, 'private', 'alice'), executionMode: 'work' });
      await receive('/work new 写三条收拾书桌的建议，每条不超过十五字。'); await channel.work.whenIdle();
      const job = channel.work.list(scope).jobs[0]; assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'sent');
      return { text: job.result.text, state: job.state, delivery: job.delivery.state };
    });
    await runCase('image_generation', async () => {
      store.setConversationSettings(accountId, 'private', 'alice', { ...store.conversationSettings(accountId, 'private', 'alice'), executionMode: 'work' });
      const config = borrowed.imageGeneration, provider = config.providers.find(row => row.id === config.defaultProviderId);
      if (reuseImage) {
        const job = channel.work.list(scope).jobs.find(row => row.imageRequest && row.state === 'succeeded' && row.delivery.state === 'partial');
        assert(job, 'No generated image awaiting a complete receipt in the isolated profile');
        const originalArtifacts = structuredClone(job.result.artifacts);
        assert(job.operations.some(row => row.tool === 'wechat_work_generate_image' && row.result.ok));
        if (job.delivery.artifacts.some(item => item.state !== 'sent')) {
          channel.work.retryDelivery(job.id, scope, { expectedUpdatedAt: job.updatedAt, expectedRetryCount: job.delivery.retryAttempts?.length || 0, confirmedNotReceived: true });
          await channel.work.whenIdle();
        }
        const recovered = channel.work.get(job.id, scope);
        assert(recovered.delivery.artifacts.every(item => item.state === 'sent'));
        assert.deepEqual(recovered.result.artifacts, originalArtifacts); assert.equal(report.modelCalls.length, 0);
        // The deliberately incomplete original text receipt must remain unknown.
        // Verify a fresh complete delivery using the exact already generated bytes;
        // this replays the API result, not the billable image-generation request.
        const artifact = originalArtifacts[0], bytes = fs.readFileSync(path.join(job.workspaceRoot, job.folder, artifact.path));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
        const service = channel.work.imageGeneration, generate = service.generate;
        let reused = 0, complete;
        service.generate = async query => {
          assert.deepEqual(query, job.imageRequest); reused++;
          return { bytes, extension: path.extname(artifact.path), providerId: provider.id, providerName: provider.name, model: job.imageRequest.model };
        };
        try {
          const replay = channel.work.create(scope, job.request, undefined, { imageRequest: job.imageRequest });
          await channel.work.whenIdle(); complete = channel.work.get(replay.id, scope);
        } finally { service.generate = generate; }
        assert.equal(reused, 1); assert.equal(complete.state, 'succeeded'); assert.equal(complete.delivery.state, 'sent', complete.delivery.reason);
        assert(complete.delivery.artifacts.every(item => item.state === 'sent'));
        return { provider: provider.id, model: provider.defaultModel, state: complete.state, delivery: complete.delivery.state,
          reusedRealImage: true, originalFileRecovery: 'sent', originalCaptionReceipt: 'unknown, preserved', newImageGenerations: 0,
          artifacts: complete.result.artifacts, receipts: complete.delivery.deliveryParts };
      }
      const job = channel.work.create(scope, '生成一张纯色背景上简单红色圆形的测试图片，无文字。', undefined,
        { imageRequest: { prompt: 'A simple red circle centered on a plain white background, flat icon, no text.', path: 'test-circle.png', providerId: provider.id, model: provider.defaultModel, size: provider.size } });
      await channel.work.whenIdle();
      const result = channel.work.get(job.id, scope); assert.equal(result.state, 'succeeded', JSON.stringify(result.error));
      assert(result.result.artifacts.length > 0); assert.equal(result.delivery.state, 'sent');
      return { provider: provider.id, model: provider.defaultModel, state: result.state, delivery: result.delivery.state, artifacts: result.result.artifacts };
    });
    await runCase('unauthorized', async () => {
      const beforeCalls = report.modelCalls.length, beforeSends = report.sends.length;
      channel.receive(message('请回复这条消息', 'unapproved-person'), accountId); await channel.whenIdle();
      assert.equal(report.modelCalls.length, beforeCalls); assert.equal(report.sends.length, beforeSends);
      return { modelCalls: 0, messagesSent: 0 };
    });
    await runCase('restart_dedup', async () => {
      await scheduler.close(); await channel.close();
      store = new StateStore(root);
      const facts = new LongTermMemory(store).view(accountId).sections.flatMap(row => row.facts);
      assert(facts.some(row => row.text.includes('燕麦奶')));
      channel = new WechatChannel({ store, runner, transport, now }); scheduler = new TaskScheduler({ store, channel, now }); channel.scheduler = scheduler;
      const before = report.modelCalls.length, beforeSends = report.sends.length;
      if (firstInput) channel.receive(firstInput, accountId); await channel.whenIdle();
      assert.equal(report.modelCalls.length, before); assert.equal(report.sends.length, beforeSends);
      return { rememberedFacts: facts.length, duplicateModelCalls: 0, duplicateSends: 0, tasks: scheduler.list(accountId).tasks.length };
    });
  } finally {
    await scheduler.close(); await channel.close();
    report.completed = true; report.finishedAt = new Date().toISOString();
    report.passed = report.cases.every(row => row.state === 'passed');
    report.summary = { passed: report.cases.filter(row => row.state === 'passed').length, failed: report.cases.filter(row => row.state === 'failed').length,
      modelRuns: report.modelCalls.length, apiRequests: report.modelCalls.reduce((total, row) => total + (row.metrics?.length || 0), 0) };
    persist(); console.log(JSON.stringify({ report: reportPath, ...report.summary, actualWechatMessages: 0 }));
  }
  return report.passed;
}
