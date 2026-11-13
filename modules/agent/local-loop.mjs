import { randomUUID } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { availableModel, visionSelection } from './models.mjs';
import { ModelClient } from './model-client.mjs';
import { publicText } from '../../backend/wechat/ai/public-output.ts';
import { INTERNAL_OUTPUT_MODES, buildWechatPrompt, messageWithHistory, memoryContext, identityData, scheduledData } from '../../prompts/reply/compose.mjs';
import { emptyResponseRetryNote } from '../../prompts/reply/delivery.mjs';
import { registerModelTools } from '../tools/registry.mjs';
import { planProgressiveTools } from '../tools/progressive.mjs';
import { measureModelRequest, numericUsage } from './request-metrics.mjs';
import { currentTrace, traceStep } from '../traces/context.mjs';

export function localTools(definitions, { assertAllowed, progressive, text }) {
  const inventory = new Map(), guards = [], sections = [];
  const context = { tools: {
    register(tool) { inventory.set(tool.name, tool); }, restrict() {}, guard(check) { guards.push(check); },
  }, systemPrompt: { section(value) { sections.push(value.text); } } };
  const plan = progressive ? planProgressiveTools(definitions, text) : { initial: definitions, deferredGroups: [] };
  const visible = registerModelTools(context, plan.initial, { deferredGroups: plan.deferredGroups, assertAllowed, quiet: true });
  return { inventory, guards, visible, sections };
}

function imageContent(image) {
  const data = typeof image.data === 'string' ? image.data : Buffer.from(image.data ?? []).toString('base64');
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType) || !data || data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(data))
    throw new ChannelError('IMAGE_INVALID', '图片格式或大小无效，未提交图像理解');
  return { type: 'image_url', image_url: { url: 'data:' + image.mediaType + ';base64,' + data } };
}
function parseCalls(values, inventory, seen) {
  if (!Array.isArray(values) || values.length > 64) throw new ChannelError('MODEL_TOOLS_INVALID', '模型返回了无效的工具列表');
  const current = new Set();
  return values.map(value => {
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 200 || current.has(value.id) || seen.has(value.id) ||
        value.type !== 'function' || !inventory.has(value.function?.name))
      throw new ChannelError('MODEL_TOOLS_INVALID', '模型请求了未开放的工具或重复操作，已停止本轮执行');
    current.add(value.id);
    let args;
    try { args = JSON.parse(value.function.arguments); } catch { throw new ChannelError('MODEL_TOOL_ARGUMENTS', '模型工具参数无法解析，未执行操作'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ChannelError('MODEL_TOOL_ARGUMENTS', '模型工具参数必须为对象');
    return { ...value, args };
  });
}

/** Independent tool loop. Conversation history remains in the existing scoped memory stores. */
export async function runLocalAgent(runner, {
  text, group, prompt, persona, adminNotes, sessionId, signal = new AbortController().signal, onSession,
  mode = 'default', history = [], memory, images = [], tools = [], systemOverride, speaker, account,
  allowEmptyReply = false, executionSnapshot, selectReplyText, naturalDecision, scheduledTask,
  onRequestMetrics, onBeforeTool, assertAllowed = () => {},
}) {
  signal.throwIfAborted(); assertAllowed();
  if (images.some(image => image.type === 'face' || image.kind === 'sticker'))
    throw new ChannelError('STICKER_VISION_SKIPPED', '表情包不调用图像理解');
  const runtime = structuredClone(executionSnapshot?.runtime ?? runner.getRuntimeSettings() ?? {});
  if (persona) runtime.persona = structuredClone(persona);
  let selected = await availableModel(runner.ctx, structuredClone(executionSnapshot?.selection ?? runner.selection()), signal);
  if (images.length) selected = await visionSelection(runner.ctx, selected, runtime.modelConfig?.visionModel, signal);
  const id = sessionId || randomUUID(), requestMetrics = [], trace = currentTrace();
  const internal = INTERNAL_OUTPUT_MODES.has(mode);
  const material = ['moments-materials', 'moments-publish'].includes(mode);
  const person = mode === 'natural' && naturalDecision || ['moments-reply', 'moments-interaction'].includes(mode);
  const definitions = material
    ? tools.filter(tool => ['wechat_moments_material_search', 'wechat_moments_material_download', 'wechat_moments_material_generate'].includes(tool.name))
    : person ? tools.filter(tool => tool.name === 'wechat_role_card') : internal || systemOverride ? []
    : [...tools, ...(runtime.modelConfig?.webSearch ? [runner.searchTool(runtime.modelConfig, { assertAllowed })] : [])];
  const strategy = runtime.modelConfig?.promptStrategy ?? 'legacy';
  const registered = localTools(definitions, { assertAllowed, progressive: strategy === 'progressive-v1', text });
  const system = buildWechatPrompt({ group, mode, persona: runtime.persona, prompt, adminNotes, identityMarkdown: runtime.identityMarkdown,
    modelConfig: runtime.modelConfig, promptStrategy: strategy, capabilities: registered.visible,
    searchAvailable: definitions.some(tool => tool.name === 'wechat_web_search'), memoryAvailable: definitions.some(tool => tool.name === 'wechat_memory'),
    systemOverride, naturalDecision, requestText: text, history, speaker }) + '\n\n' + registered.sections.join('\n');
  const inputText = [identityData(speaker, account, runtime.persona), scheduledData(scheduledTask, mode),
    memoryContext(memory), messageWithHistory(text, history, mode, undefined)].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: images.length
    ? [{ type: 'text', text: inputText }, ...images.map(imageContent)] : inputText }];
  const client = runner.client ??= new ModelClient(runner.ctx.llm, { fetchImpl: runner.ctx.fetch });
  // An edited endpoint or key applies to the next run, never midway through a tool loop.
  const connection = client.providers ? await client.providers.selectionRequest(selected) : undefined;
  const seen = new Set(); let emptyResponseRetries = 0, toolUsed = false;
  await onSession?.(id);
  for (let round = 0; round < 64; round++) {
    signal.throwIfAborted(); assertAllowed();
    const activeTools = [...registered.inventory.values()];
    const metric = { sessionId: id, strategy, mode, startedAt: Date.now(), ...measureModelRequest({ messages, tools: activeTools }) };
    const step = trace?.store.startStep(trace, { kind: 'model', title: '模型生成 · ' + mode,
      input: { messages, tools: activeTools.map(({ name, description, parameters }) => ({ name, description, parameters })) },
      metadata: { sessionId: id, provider: selected.provider, model: selected.model, mode, ...metric } });
    let result;
    try {
      result = await client.complete({ selection: selected, messages, tools: activeTools,
        maxTokens: runtime.modelConfig?.maxTokens, temperature: runtime.modelConfig?.temperature, signal, connection });
      metric.usage = numericUsage(result.usage); metric.finishReason = result.finishReason;
      step?.end({ state: ['stop', 'tool_calls'].includes(result.finishReason) ? 'completed' : 'failed',
        output: { content: result.message.content, tools: result.message.tool_calls, usage: metric.usage }, metadata: { usage: metric.usage, finishReason: result.finishReason } });
    } catch (error) { step?.end({ error, state: signal.aborted ? 'cancelled' : 'failed' }); throw error; }
    finally { metric.elapsedMs = Date.now() - metric.startedAt; requestMetrics.push(metric); onRequestMetrics?.(structuredClone(requestMetrics)); }
    signal.throwIfAborted(); assertAllowed();
    if (!['stop', 'tool_calls'].includes(result.finishReason))
      throw new ChannelError('MODEL_INCOMPLETE', result.finishReason === 'length' ? '模型达到输出上限，未发送不完整回复' : '模型未正常完成生成，未发送回复');
    const calls = parseCalls(result.message.tool_calls ?? [], registered.inventory, seen);
    if (calls.length) {
      // Validate the complete batch before the first side effect. No network retry replays these tools.
      messages.push(result.message); toolUsed = true;
      for (const call of calls) {
        signal.throwIfAborted(); assertAllowed(); seen.add(call.id);
        const execution = { id: call.id, name: call.function.name, arguments: call.args, signal,
          executionSnapshot: structuredClone({ runtime, selection: selected }) };
        for (const guard of registered.guards) {
          const denied = guard(execution); if (denied) throw new ChannelError('TOOL_NOT_AUTHORIZED', denied);
        }
        await onBeforeTool?.(execution.name, call.args, execution);
        signal.throwIfAborted(); assertAllowed();
        const value = await traceStep(execution.name, () => registered.inventory.get(execution.name).execute(call.args, execution),
          { context: trace, kind: 'tool', input: call.args, metadata: { sessionId: id, tool: execution.name, callId: call.id } });
        signal.throwIfAborted(); assertAllowed();
        messages.push({ role: 'tool', tool_call_id: call.id, content: typeof value === 'string' ? value : JSON.stringify(value ?? null) });
      }
      continue;
    }
    if (result.finishReason !== 'stop') throw new ChannelError('MODEL_INCOMPLETE', '模型未返回最终正文');
    const raw = result.message.content ?? '';
    let reply = publicText(typeof selectReplyText === 'function' ? selectReplyText(raw) : raw);
    const allowEmpty = typeof allowEmptyReply === 'function' ? allowEmptyReply() : allowEmptyReply;
    if (!reply && !allowEmpty) {
      if (!toolUsed && !emptyResponseRetries) { emptyResponseRetries++; messages.push({ role: 'user', content: emptyResponseRetryNote() }); continue; }
      throw new ChannelError('MODEL_EMPTY', '模型没有返回可用的最终正文，未发送微信回复');
    }
    let replyStyleWarning;
    if (!internal && (!systemOverride || mode === 'confirmation') && reply)
      reply = await runner.polishReply(reply, text, signal, runtime.persona, { prompt, runtime, onStyleWarning: note => { replyStyleWarning = note; } });
    return { text: reply, sessionId: id, requestMetrics, ...(emptyResponseRetries ? { emptyResponseRetries } : {}), ...(replyStyleWarning ? { replyStyleWarning } : {}) };
  }
  throw new ChannelError('MODEL_TOOL_LIMIT', '本轮工具调用已达到上限，已停止继续执行，请查看执行记录');
}
