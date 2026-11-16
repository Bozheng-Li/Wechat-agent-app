// Counts in-flight RPCs so the window can show that something is still loading.
// A counter rather than a boolean: several pages load in parallel, and the bar must
// only disappear after the last one settles.
let active = 0;
const listeners = new Set();
const emit = () => { for (const listener of listeners) listener(); };

export const busyStore = {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  getSnapshot: () => active,
  begin() { active += 1; emit(); },
  end() { active = Math.max(0, active - 1); emit(); },
};

export async function track(operation) {
  busyStore.begin();
  try { return await operation; } finally { busyStore.end(); }
}
