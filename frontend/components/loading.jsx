import { useEffect, useState, useSyncExternalStore } from 'react';
import { busyStore } from '../busy.mjs';

// Two shapes of feedback: a thin window-level bar while any request is in flight,
// and an in-page placeholder for a region that has nothing to show yet.
const css = `
.wa-topbar{position:fixed;left:0;right:0;top:0;height:2px;z-index:60;opacity:0;transition:opacity .25s ease;pointer-events:none;overflow:hidden}
.wa-topbar[data-active="true"]{opacity:1}
.wa-topbar-fill{height:100%;width:34%;border-radius:0 2px 2px 0;background:linear-gradient(90deg,rgba(47,208,122,.15),#17b169);animation:wa-topbar-slide 1.1s ease-in-out infinite}
@keyframes wa-topbar-slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
.wa-loading{display:flex;flex-direction:column;gap:10px;padding:8px 0}
.wa-loading-head{display:flex;align-items:center;gap:8px;font-size:13px;color:#5b6a63}
.wa-loading-spinner{width:13px;height:13px;border-radius:50%;border:2px solid #cfdcd5;border-top-color:#17b169;animation:wa-spin .8s linear infinite}
.wa-loading-track{height:3px;border-radius:999px;background:#e3eae6;overflow:hidden}
.wa-loading-fill{height:100%;width:38%;border-radius:999px;background:linear-gradient(90deg,#2fd07a,#17b169);animation:wa-loading-slide 1.3s ease-in-out infinite}
.wa-loading-skeleton{display:flex;flex-direction:column;gap:8px;margin-top:2px}
.wa-loading-skeleton i{display:block;height:11px;border-radius:6px;background:linear-gradient(90deg,#eef2f0 25%,#e1e9e3 37%,#eef2f0 63%);background-size:400% 100%;animation:wa-shimmer 1.5s ease infinite}
.wa-loading-skeleton i:nth-child(2){width:86%}
.wa-loading-skeleton i:nth-child(3){width:62%}
@keyframes wa-spin{to{transform:rotate(360deg)}}
@keyframes wa-loading-slide{0%{transform:translateX(-110%)}100%{transform:translateX(260%)}}
@keyframes wa-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
@media (prefers-reduced-motion:reduce){.wa-topbar-fill,.wa-loading-fill,.wa-loading-skeleton i,.wa-loading-spinner{animation:none}}
`;

/** True once `active` has lasted `delay`, so a 20 ms request never flashes a bar. */
function useSettled(active, delay = 180) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) { setShown(false); return undefined; }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
  return shown;
}

export function TopProgress() {
  const active = useSyncExternalStore(busyStore.subscribe, busyStore.getSnapshot, busyStore.getSnapshot);
  const shown = useSettled(active > 0);
  return <div className="wa-topbar" data-active={shown ? 'true' : 'false'} role="progressbar" aria-label="正在加载数据">
    <style>{css}</style>
    <div className="wa-topbar-fill" />
  </div>;
}

/** In-page placeholder: a labelled bar plus skeleton lines, for regions still loading. */
export function LoadingBar({ label = '正在加载…', rows = 3 }) {
  return <div className="wa-loading" role="status" aria-live="polite">
    <style>{css}</style>
    <div className="wa-loading-head"><span className="wa-loading-spinner" aria-hidden="true" /><span>{label}</span></div>
    <div className="wa-loading-track"><div className="wa-loading-fill" /></div>
    {rows > 0 && <div className="wa-loading-skeleton" aria-hidden="true">{Array.from({ length: rows }, (_, index) => <i key={index} />)}</div>}
  </div>;
}
