import { CHANNEL } from "../../shared/contracts.mjs";

// One timeout policy for the pages instead of one per call site: a caller that
// already owns a signal keeps it and still gets the page timeout on top, while a
// caller without a signal gets a plain timeout. `AbortSignal.any([signal, ...])`
// threw a TypeError whenever `signal` was undefined, so it must not be inlined.
export function withTimeout(signal, ms) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

export function memoryRpcTimeoutMs(endpoint) {
  // The worker allows 5 minutes for batched label reads. Leave room for its
  // coded result instead of cancelling it at the ordinary page's 30 seconds.
  if (endpoint === 'memory.role.labels' || endpoint === 'moments.audience') return 310000;
  return ['memory.compress', 'memory.retryImages', 'memory.global.extract', 'memory.images.import'].includes(endpoint) ? 300000 : 30000;
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
    const reason = signal?.aborted ? signal.reason : cause;
    const labels = ['memory.role.labels', 'moments.audience'].includes(endpoint);
    if (reason?.name === 'TimeoutError') {
      error.code = 'RPC_TIMEOUT';
      if (labels) error.message = '微信标签读取超过本页等待时限，本次读取已取消；请重试。';
    } else if (reason?.name === 'AbortError') {
      error.code = 'RPC_ABORTED';
      if (labels) error.message = '本次标签读取已取消，可以重新读取。';
    } else {
      error.code = /^[A-Z][A-Z0-9_]{0,63}$/.test(cause?.code ?? '') ? cause.code : 'RPC_UNAVAILABLE';
      if (labels) error.message = '应用页面与后台通信失败，未取得标签读取结果；请先重载页面后重试。';
    }
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
