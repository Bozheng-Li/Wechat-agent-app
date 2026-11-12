import React from 'react';
import { createRoot } from 'react-dom/client';
import { WechatPanel } from './panel.jsx';

const connection = { rpc: { call(_channel, endpoint, payload, signal) {
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cancel = () => { window.wechatApp.cancel(id); reject(signal.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
    window.wechatApp.request(id, endpoint, payload).then(resolve, reject).finally(() => signal?.removeEventListener('abort', cancel));
  });
} } };
let snapshot = { status: 'idle', value: null }, pending;
const listeners = new Set();
const publish = value => { snapshot = value; for (const listener of listeners) listener(); };
const catalog = {
  store: { subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); }, getSnapshot: () => snapshot },
  load() { return snapshot.status === 'ready' ? Promise.resolve(snapshot.value) : catalog.refresh(); },
  refresh() {
    if (pending) return pending;
    publish({ ...snapshot, status: 'loading' });
    pending = connection.rpc.call('/wechat-agent', 'models.catalog', {}, AbortSignal.timeout(10000)).then(result => {
      if (!result.ok) throw new Error(result.error.message);
      publish({ status: 'ready', value: result.value }); return result.value;
    }).catch(error => { publish({ ...snapshot, status: 'error' }); throw error; }).finally(() => { pending = null; });
    return pending;
  },
};
document.addEventListener('click', event => {
  const link = event.target.closest?.('a[href]');
  if (!link || !/^https?:/i.test(link.href)) return;
  event.preventDefault(); void window.wechatApp.openExternal(link.href).catch(() => {});
});
createRoot(document.getElementById('root')).render(<WechatPanel connection={connection} catalog={catalog} />);
