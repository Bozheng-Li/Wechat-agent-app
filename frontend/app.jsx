import React from 'react';
import { createRoot } from 'react-dom/client';
import { WechatPanel } from './panel.jsx';
import { BootScreen, useBootGate } from './boot-screen.jsx';
import { TopProgress } from './components/loading.jsx';
import { track } from './busy.mjs';

const connection = { rpc: { call(_channel, endpoint, payload, signal) {
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  // Counted here so every page gets the same "still loading" feedback.
  return track(new Promise((resolve, reject) => {
    const cancel = () => { window.wechatApp.cancel(id); reject(signal.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
    window.wechatApp.request(id, endpoint, payload).then(resolve, reject).finally(() => signal?.removeEventListener('abort', cancel));
  }));
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
// The window is visible long before the data layer is, so the panel waits behind a
// startup screen instead of racing the first RPCs (which used to time out after 10s).
function Shell() {
  const { ready, boot } = useBootGate();
  if (!ready) return <BootScreen {...boot} />;
  return <><TopProgress /><WechatPanel connection={connection} catalog={catalog} /></>;
}

createRoot(document.getElementById('root')).render(<Shell />);
