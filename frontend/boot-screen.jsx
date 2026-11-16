import React, { useEffect, useState } from 'react';

// The main window is shown before the data layer is ready, so this screen is what
// the person sees during startup. It mirrors the tray/app mark instead of a blank
// white window, and it reports the real stage the backend is in.
const css = `
.wa-boot{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  background:radial-gradient(120% 90% at 50% 0%,#fbfcfb 0%,#f2f5f3 55%,#e9eeeb 100%);color:#1f2a24;
  font-family:"PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none;-webkit-app-region:drag}
.wa-boot *{-webkit-app-region:drag}
.wa-boot-mark{width:88px;height:88px;border-radius:25px;position:relative;margin-bottom:26px;
  background:linear-gradient(160deg,#3ede87 0%,#17b169 100%);box-shadow:0 16px 34px rgba(23,177,105,.28);
  animation:wa-boot-breathe 2.8s ease-in-out infinite}
.wa-boot-mark::before{content:"";position:absolute;left:23px;top:31px;width:36px;height:25px;border-radius:9px;background:#fff}
.wa-boot-mark::after{content:"";position:absolute;left:23px;top:50px;width:9px;height:9px;border-radius:0 0 0 7px;background:#fff}
@keyframes wa-boot-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
.wa-boot-title{font-size:22px;font-weight:600;letter-spacing:.5px}
.wa-boot-version{margin-top:7px;font-size:12.5px;color:#7c8a83;letter-spacing:.4px}
.wa-boot-track{position:relative;width:min(360px,62vw);height:4px;border-radius:999px;background:#dfe6e1;overflow:hidden;margin-top:38px}
.wa-boot-bar{height:100%;border-radius:999px;background:linear-gradient(90deg,#2fd07a,#17b169);transition:width .45s cubic-bezier(.2,.7,.3,1)}
.wa-boot-bar::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);
  animation:wa-boot-shimmer 1.6s linear infinite}
@keyframes wa-boot-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.wa-boot-stage{margin-top:20px;font-size:13.5px;color:#55635c;min-height:20px}
.wa-boot-note{margin-top:10px;font-size:12.5px;color:#8a978f;max-width:420px;text-align:center;line-height:1.6}
@media (prefers-reduced-motion:reduce){.wa-boot-mark,.wa-boot-bar::after{animation:none}}
`;

export function BootScreen({ label = '正在启动…', percent = 8, version = '', note = '' }) {
  return (
    <div className="wa-boot" role="status" aria-live="polite">
      <style>{css}</style>
      <div className="wa-boot-mark" aria-hidden="true" />
      <div className="wa-boot-title">微信 Agent</div>
      {version ? <div className="wa-boot-version">{version}</div> : null}
      <div className="wa-boot-track"><div className="wa-boot-bar" style={{ width: `${Math.max(4, Math.min(99, percent))}%` }} /></div>
      <div className="wa-boot-stage">{label}</div>
      {note ? <div className="wa-boot-note">{note}</div> : null}
    </div>
  );
}

const SLOW_NOTE = '首次启动需要整理历史数据，时间会稍长一些；完成后会自动进入。';

/** Holds the panel back until the backend says it is ready, so the first RPCs never race startup. */
export function useBootGate() {
  const api = typeof window === 'undefined' ? undefined : window.wechatApp?.boot;
  const [state, setState] = useState(() => api?.state?.() ?? { label: '正在启动…', percent: 8, version: '', ready: true });
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!api) return undefined;
    const offBoot = api.onBoot(value => setState(current => ({ ...current, ...value })));
    const offReady = api.onReady(value => setState(current => ({ ...current, ...value, ready: true })));
    return () => { offBoot?.(); offReady?.(); };
  }, [api]);
  useEffect(() => {
    if (state.ready) { setSlow(false); return undefined; }
    // A single stage can legitimately take a while on the first run; say so instead
    // of leaving a still bar with no explanation.
    const timer = setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(timer);
  }, [state.ready, state.label]);
  return { ready: state.ready, boot: { label: state.label, percent: state.percent, version: state.version, note: slow ? SLOW_NOTE : '' } };
}
