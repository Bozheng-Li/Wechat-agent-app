import { useCallback, useEffect, useRef, useState } from 'react';

const idle = {
  phase: 'idle',
  version: '',
  currentVersion: '',
  size: 0,
  releaseDate: '',
  pageURL: '',
  percent: 0,
  received: 0,
  total: 0,
  path: '',
  message: '',
  checkedAt: null,
  differential: null,
};

// Update state lives in the main process; this hook only mirrors it and keeps
// one download at a time so the renderer cannot queue duplicate transfers.
export function useUpdate({ autoCheck = true, delay = 4000 } = {}) {
  const bridge = typeof window === 'undefined' ? null : window.wechatApp;
  const supported = typeof bridge?.checkUpdate === 'function';
  const [state, setState] = useState(idle);
  const [hidden, setHidden] = useState('');
  const running = useRef(false), mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!supported) return undefined;
    return bridge.onUpdateProgress(progress => {
      setState(current => current.phase === 'downloading'
        ? { ...current, percent: progress.percent, received: progress.received, total: progress.total || current.total }
        : current);
    });
  }, [bridge, supported]);

  const check = useCallback(async ({ quiet = false } = {}) => {
    if (!supported || running.current) return null;
    running.current = true;
    if (!quiet) setState(current => ({ ...current, phase: 'checking', message: '' }));
    const reply = await bridge.checkUpdate().catch(() => ({ ok: false, error: { message: '暂时无法连接更新服务' } }));
    running.current = false;
    if (!mounted.current) return null;
    if (!reply?.ok) {
      setState(current => ({ ...current, phase: 'error', message: reply?.error?.message || '检查更新失败，请稍后再试' }));
      return null;
    }
    const value = reply.value || {};
    setState({
      ...idle,
      phase: value.status === 'available' ? 'available' : 'current',
      version: value.version || '',
      currentVersion: value.currentVersion || '',
      size: value.size || 0,
      releaseDate: value.releaseDate || '',
      pageURL: value.pageURL || '',
      total: value.size || 0,
      checkedAt: Date.now(),
    });
    return value;
  }, [bridge, supported]);

  const download = useCallback(async () => {
    if (!supported || running.current) return null;
    running.current = true;
    setState(current => ({ ...current, phase: 'downloading', percent: 0, received: 0, message: '' }));
    const reply = await bridge.downloadUpdate().catch(() => ({ ok: false, error: { message: '下载更新包失败，请检查网络' } }));
    running.current = false;
    if (!mounted.current) return null;
    if (!reply?.ok) {
      // A cancel from this window is not a failure; keep the release offered.
      if (reply?.error?.code === 'UPDATE_CANCELLED') {
        setState(current => ({ ...current, phase: 'available', percent: 0, received: 0, message: '' }));
        return null;
      }
      setState(current => ({ ...current, phase: 'error', message: reply?.error?.message || '下载更新包失败，请重试' }));
      return null;
    }
    setState(current => ({
      ...current,
      phase: 'ready',
      percent: 100,
      received: reply.value?.size || current.total,
      path: reply.value?.path || '',
      // Only the main process knows whether the bytes were reused; the banner
      // reports the saving and nothing else depends on it.
      differential: reply.value?.differential || { used: false },
      message: '',
    }));
    return reply.value;
  }, [bridge, supported]);

  const install = useCallback(async () => {
    if (!supported) return null;
    setState(current => ({ ...current, phase: 'installing', message: '' }));
    const reply = await bridge.installUpdate().catch(() => ({ ok: false, error: { message: '无法启动安装程序' } }));
    if (!mounted.current) return null;
    if (!reply?.ok) {
      setState(current => ({ ...current, phase: 'ready', message: reply?.error?.message || '无法启动安装程序' }));
      return null;
    }
    return reply.value;
  }, [bridge, supported]);

  const cancel = useCallback(() => {
    void bridge?.cancelUpdate?.();
    setState(current => (current.phase === 'downloading' ? { ...current, phase: 'available', percent: 0, received: 0 } : current));
  }, [bridge]);

  const dismiss = useCallback(() => setHidden(state.version), [state.version]);

  const openReleasePage = useCallback(() => {
    if (state.pageURL) void bridge?.openExternal?.(state.pageURL);
  }, [bridge, state.pageURL]);

  useEffect(() => {
    if (!autoCheck || !supported) return undefined;
    const timer = setTimeout(() => { void check({ quiet: true }); }, delay);
    return () => clearTimeout(timer);
  }, [autoCheck, supported, delay, check]);

  const banner = supported && !!state.version && hidden !== state.version
    && ['available', 'downloading', 'ready', 'installing'].includes(state.phase);

  return { supported, state, banner, check, download, install, cancel, dismiss, openReleasePage };
}
