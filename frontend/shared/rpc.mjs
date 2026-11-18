import { CHANNEL } from "../../shared/contracts.mjs";

// One timeout policy for the pages instead of one per call site: a caller that
// already owns a signal keeps it and still gets the page timeout on top, while a
// caller without a signal gets a plain timeout. `AbortSignal.any([signal, ...])`
// threw a TypeError whenever `signal` was undefined, so it must not be inlined.
export function withTimeout(signal, ms) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

export async function call(connection, endpoint, payload = {}, signal) {
  let result;
  try {
    result = await connection.rpc.call(CHANNEL, endpoint, payload, signal);
  } catch (cause) {
    // Keep the transport failure attached: without it a timeout, an intentional
    // abort and a main-process crash are indistinguishable in the UI and in logs.
    const error = new Error(
      [
        'status',
        'contacts',
        'records.list',
        'traces.list',
        'traces.get',
        'traces.content',
        'traces.export',
        'changelog',
        'identity.get',
        'model.info',
        'memory.list',
        'memory.get',
        'memory.role.get',
        'memory.role.list',
        'time.list',
        'tasks.list',
        'moments.list',
        'moments.likes.list',
        'moments.interactions.list',
        'moments.read',
        'moments.images',
        'moments.audience',
        'moments.discover',
      ].includes(endpoint)
        ? '暂时无法读取微信助手，请检查应用连接后重试。'
        : '未能确认操作结果，请重新读取状态，核对是否已保存后再试。'
    );
    error.cause = cause;
    if (typeof cause?.name === 'string') error.code = cause.name === 'AbortError' ? 'RPC_ABORTED' : 'RPC_UNAVAILABLE';
    throw error;
  }
  if (!result?.ok) {
    const error = new Error(result?.error?.message || '操作未完成，请核对当前状态后重试。');
    if (typeof result?.error?.code === 'string') error.code = result.error.code;
    if (['not-sent', 'rejected'].includes(result?.error?.delivery)) error.delivery = result.error.delivery;
    throw error;
  }
  return result.value;
}
