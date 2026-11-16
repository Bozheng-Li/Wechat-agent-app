import { ChannelError } from '../../shared/contracts.mjs';

const MAX_RESPONSE = 32 * 1024 * 1024;
const fail = (code, message) => new ChannelError(code, message);
async function assertOk(response) {
  if (response.ok) return;
  await response.body?.cancel().catch(() => {});
  throw fail('MODEL_HTTP', `模型服务返回 HTTP ${response.status}，${[401, 403].includes(response.status) ? '请检查 API Key 和模型权限' : response.status === 429 ? '请检查额度或稍后再试' : '请检查接口地址和模型设置'}`);
}
const partText = part => typeof part === 'string' ? part
  : part?.type === 'text' || part?.type === 'output_text' ? part.text ?? '' : '';
const chatText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(partText).join('') : '';

// The Responses API takes flat tool objects and typed input items, so the chat-shaped
// messages the agent loop keeps in memory are translated in both directions. One
// normalized result keeps the tool loop free of transport branches.
export function responsesTools(tools) {
  return tools.map(({ name, description, parameters }) =>
    ({ type: 'function', name, description, ...(parameters ? { parameters } : {}) }));
}
function responsesContent(content) {
  if (typeof content === 'string' || content == null) return content ?? '';
  return content.map(part => part?.type === 'text' ? { type: 'input_text', text: String(part.text ?? '') }
    : part?.type === 'image_url' ? { type: 'input_image', image_url: part.image_url?.url ?? '' } : part);
}
export function responsesInput(messages) {
  const input = [];
  for (const message of messages ?? []) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') });
      continue;
    }
    if (message.role === 'assistant') {
      const text = chatText(message.content);
      if (text) input.push({ role: 'assistant', content: text });
      for (const call of message.tool_calls ?? [])
        input.push({ type: 'function_call', call_id: call.id, name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' });
      continue;
    }
    input.push({ role: message.role, content: responsesContent(message.content) });
  }
  return input;
}
export function responsesResult(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  let text = '', reasoning = '';
  const calls = [];
  for (const item of output) {
    if (item?.type === 'message') text += chatText(item.content);
    else if (item?.type === 'reasoning' && Array.isArray(item.summary)) reasoning += item.summary.map(part => part?.text ?? '').join('');
    else if (item?.type === 'function_call' && typeof item.name === 'string' && item.name)
      calls.push({ id: String(item.call_id || item.id || ''), type: 'function', function: { name: item.name,
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) } });
  }
  const finishReason = calls.length ? 'tool_calls' : payload?.status && payload.status !== 'completed' ? 'length' : 'stop';
  return { message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}),
    ...(reasoning ? { reasoning_content: reasoning } : {}) }, finishReason, usage: payload?.usage };
}

export async function readModelResponse(response, signal) {
  await assertOk(response);
  const reader = response.body?.getReader();
  if (!reader) throw fail('MODEL_RESPONSE', '模型服务返回了空响应');
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  const decoder = new TextDecoder(); let buffer = '', size = 0, text = '', reasoning = '', finish, usage, doneMarker = false;
  const calls = new Map();
  const consume = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { doneMarker = true; return; }
    let event; try { event = JSON.parse(data); } catch { throw fail('MODEL_STREAM_INVALID', '模型返回的流式数据无法解析'); }
    if (event.error) throw fail('MODEL_RESPONSE', '模型服务在生成过程中返回错误，未发送回复');
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0]; if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string') text += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (choice.finish_reason) finish = choice.finish_reason;
    for (const value of delta.tool_calls ?? []) {
      if (!Number.isSafeInteger(value.index) || value.index < 0 || value.index > 63) throw fail('MODEL_TOOLS_INVALID', '模型返回的工具编号无效');
      const item = calls.get(value.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (value.id) item.id = value.id;
      if (value.function?.name) item.function.name += value.function.name;
      if (value.function?.arguments) item.function.arguments += value.function.arguments;
      calls.set(value.index, item);
    }
  };
  try {
    for (;;) {
      signal?.throwIfAborted(); const { value, done } = await reader.read();
      if (value) { size += value.byteLength; if (size > MAX_RESPONSE) throw fail('MODEL_RESPONSE_TOO_LARGE', '模型响应过大，已停止读取'); }
      buffer += decoder.decode(value, { stream: !done });
      if (sse) {
        let match; while ((match = /\r?\n\r?\n/.exec(buffer))) { consume(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); }
      }
      if (done) break;
    }
    if (!sse) {
      let json; try { json = JSON.parse(buffer); } catch { throw fail('MODEL_RESPONSE', '模型服务没有返回兼容的 JSON 数据'); }
      if (json.error) throw fail('MODEL_RESPONSE', '模型服务返回错误，请检查接口与模型配置');
      const choice = json.choices?.[0];
      if (!choice?.message) throw fail('MODEL_RESPONSE', '模型服务没有返回消息');
      const content = choice.message.content;
      return { message: { role: 'assistant', content: typeof content === 'string' || content === null ? content :
        Array.isArray(content) ? content.filter(value => value.type === 'text').map(value => value.text ?? '').join('') : '',
        ...(choice.message.tool_calls?.length ? { tool_calls: choice.message.tool_calls } : {}),
        ...(typeof choice.message.reasoning_content === 'string' ? { reasoning_content: choice.message.reasoning_content } : {}) },
        finishReason: choice.finish_reason, usage: json.usage };
    }
    if (buffer.trim()) consume(buffer);
    if (!finish || !doneMarker) throw fail('MODEL_STREAM_INCOMPLETE', '模型连接提前结束，未将未完成的内容发送到微信');
    return { message: { role: 'assistant', content: text || null, ...(calls.size ? { tool_calls: [...calls.values()] } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}) }, finishReason: finish, usage };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function readResponsesResponse(response, signal) {
  await assertOk(response);
  const reader = response.body?.getReader();
  if (!reader) throw fail('MODEL_RESPONSE', '模型服务返回了空响应');
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  const decoder = new TextDecoder(); let buffer = '', size = 0, text = '', usage, completed, doneMarker = false;
  const consume = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { doneMarker = true; return; }
    let event; try { event = JSON.parse(data); } catch { throw fail('MODEL_STREAM_INVALID', '模型返回的流式数据无法解析'); }
    if (event.type === 'error' || event.type === 'response.failed') throw fail('MODEL_RESPONSE', '模型服务在生成过程中返回错误，未发送回复');
    if (typeof event.delta === 'string') text += event.delta;
    if (event.usage) usage = event.usage;
    if (event.type === 'response.completed' && event.response) completed = event.response;
  };
  try {
    for (;;) {
      signal?.throwIfAborted(); const { value, done } = await reader.read();
      if (value) { size += value.byteLength; if (size > MAX_RESPONSE) throw fail('MODEL_RESPONSE_TOO_LARGE', '模型响应过大，已停止读取'); }
      buffer += decoder.decode(value, { stream: !done });
      if (sse) {
        let match; while ((match = /\r?\n\r?\n/.exec(buffer))) { consume(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); }
      }
      if (done) break;
    }
    if (!sse) {
      let json; try { json = JSON.parse(buffer); } catch { throw fail('MODEL_RESPONSE', '模型服务没有返回兼容的 JSON 数据'); }
      if (json.error) throw fail('MODEL_RESPONSE', '模型服务返回错误，请检查接口与模型配置');
      return responsesResult(json);
    }
    if (buffer.trim()) consume(buffer);
    if (completed) return responsesResult(completed);
    // Some relays only stream deltas and a [DONE] marker; the text is still complete
    // there, but anything without a marker stays unfinished and is never sent.
    if (text && doneMarker) return { message: { role: 'assistant', content: text }, finishReason: 'stop', usage };
    throw fail('MODEL_STREAM_INCOMPLETE', '模型连接提前结束，未将未完成的内容发送到微信');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class ModelClient {
  constructor(providers, { fetchImpl = globalThis.fetch } = {}) { this.providers = providers; this.fetch = fetchImpl; }
  async complete({ selection, messages, tools = [], maxTokens, temperature, signal, onRequest, connection }) {
    signal.throwIfAborted();
    const { provider, apiKey } = connection ?? await this.providers.selectionRequest(selection);
    const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) };
    if (provider.apiFormat === 'responses') {
      const body = { model: selection.model, input: responsesInput(messages), stream: provider.stream,
        ...(tools.length ? { tools: responsesTools(tools), tool_choice: 'auto', parallel_tool_calls: false } : {}),
        ...(maxTokens != null ? { max_output_tokens: maxTokens } : {}), ...(temperature != null ? { temperature } : {}),
        ...(selection.reasoningEffort !== undefined ? { reasoning: { effort: selection.reasoningEffort } } : {}) };
      onRequest?.(body);
      let response;
      try { response = await this.fetch(provider.baseURL + '/responses', { method: 'POST', redirect: 'error', signal, headers, body: JSON.stringify(body) }); }
      catch { signal.throwIfAborted(); throw fail('MODEL_CONNECT_FAILED', '无法连接模型服务，请检查 API 地址和网络'); }
      return readResponsesResponse(response, signal);
    }
    const body = { model: selection.model, messages, stream: provider.stream,
      ...(tools.length ? { tools: tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })), parallel_tool_calls: false } : {}),
      ...(provider.stream ? { stream_options: { include_usage: true } } : {}),
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}), ...(temperature != null ? { temperature } : {}),
      ...(selection.reasoningEffort !== undefined ? { reasoning_effort: selection.reasoningEffort } : {}) };
    onRequest?.(body);
    let response;
    try { response = await this.fetch(provider.baseURL + '/chat/completions', { method: 'POST', redirect: 'error', signal, headers, body: JSON.stringify(body) }); }
    catch { signal.throwIfAborted(); throw fail('MODEL_CONNECT_FAILED', '无法连接模型服务，请检查 API 地址和网络'); }
    return readModelResponse(response, signal);
  }
}
