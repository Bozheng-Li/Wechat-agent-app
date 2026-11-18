import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYAML } from 'yaml';
import { atomicBytes } from './atomic-text.mjs';
import { ChannelError } from '../../shared/contracts.mjs';

/**
 * A data root is the single directory that owns config.yaml, storage/state and
 * every data tree. The DSH plugin records its root in
 * `<DSH home>/wechat-agent/location.json`; the desktop app mirrors that file in
 * its own home so both ends can point at one shared folder.
 */
export const LOCATION_FILE = 'location.json';

/** Electron writes these next to the app data; they never move between ends. */
const VOLATILE = new Set([
  'Blob Storage', 'Cache', 'Code Cache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Dictionaries',
  'GPUCache', 'Local Storage', 'Network', 'Preferences', 'Session Storage', 'Shared Dictionary',
  'SharedStorage', 'Local State', 'DIPS', 'DIPS-wal', 'SingletonCookie', 'SingletonLock',
  'SingletonSocket', 'tmp', 'owner.lock',
]);

const MAX_BYTES = 8 * 1024 * 1024 * 1024;
/**
 * The size of a data root is only shown on the settings page, which asks for the
 * current and the plugin root in one synchronous call. Bound the walk so opening
 * that page can never sit behind a large tree: what was counted so far is reported
 * as a lower bound instead of an error.
 */
const SCAN_LIMIT = { entries: 20000, milliseconds: 50 };
const TIME_CHECK_INTERVAL = 256;

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Config files are YAML, so the store identity and accounts need a real parse. */
function configOf(directory) {
  let text;
  try { text = fs.readFileSync(path.join(directory, 'config.yaml'), 'utf8'); } catch { return {}; }
  try { return parseYAML(text) ?? {}; } catch { return {}; }
}

function configStoreId(directory) {
  const id = configOf(directory).ownerStoreId;
  return typeof id === 'string' ? id : undefined;
}

/** WeChat accounts stored in one data root; each account owns its own records. */
export function accountsOf(directory) {
  const accounts = configOf(directory).accounts;
  return accounts && typeof accounts === 'object' && !Array.isArray(accounts) ? Object.keys(accounts) : [];
}

/**
 * `bytes` is what was counted; `truncated` says the walk stopped at the budget, so
 * the real size is at least that much. Unreadable entries are skipped, never fatal.
 */
function directorySize(directory) {
  const startedAt = Date.now();
  let total = 0,
    inspected = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      inspected++;
      if (inspected > SCAN_LIMIT.entries ||
          (inspected % TIME_CHECK_INTERVAL === 0 && Date.now() - startedAt > SCAN_LIMIT.milliseconds))
        return { bytes: total, truncated: true };
      if (VOLATILE.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isSymbolicLink()) continue;
      else {
        try { total += fs.statSync(target).size; } catch { /* Skip unreadable entries. */ }
        if (total > MAX_BYTES) return { bytes: total, truncated: true };
      }
    }
  }
  return { bytes: total, truncated: false };
}

/** True when `child` is `parent` itself or lives anywhere below it. */
export function withinDirectory(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function locationFile(home) { return path.join(path.resolve(home), LOCATION_FILE); }

/** Tolerant read: a corrupt pointer must never keep the app from starting. */
export function readLocation(home) {
  const file = locationFile(home);
  if (!fs.existsSync(file)) return undefined;
  const value = readJSON(file);
  // The pointer exists but is unusable. Falling back silently hid where the
  // owner's data really lives and the next switch overwrote the evidence.
  if (!value || typeof value !== 'object' || typeof value.root !== 'string' || !path.isAbsolute(value.root))
    return { corrupt: true };
  return {
    root: path.resolve(value.root),
    storeId: typeof value.storeId === 'string' ? value.storeId : undefined,
    pending: value.pending && typeof value.pending === 'object' ? value.pending : undefined,
    lastSwitchError: typeof value.lastSwitchError === 'string' ? value.lastSwitchError.slice(0, 400) : undefined,
  };
}

export function writeLocation(home, value) {
  const payload = { version: 1, root: path.resolve(value.root) };
  if (value.storeId) payload.storeId = value.storeId;
  if (value.pending) payload.pending = value.pending;
  if (value.lastSwitchError) payload.lastSwitchError = value.lastSwitchError;
  atomicBytes(locationFile(home), JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

/** Cheap check used before any store opens: who, if anyone, owns this root. */
export function lockHolder(root) {
  const owner = readJSON(path.join(path.resolve(root), 'owner.lock'));
  if (!owner) return undefined;
  return alive(owner.pid) || alive(owner.workerPid) ? { pid: owner.pid, workerPid: owner.workerPid } : undefined;
}

export function describeDataRoot(root, { current } = {}) {
  const resolved = path.resolve(root);
  const exists = fs.existsSync(resolved);
  const config = path.join(resolved, 'config.yaml');
  const state = path.join(resolved, 'storage/state/channel.json');
  const locked = lockHolder(resolved);
  // One bounded walk: `bytes` is a lower bound whenever `truncated` is set.
  const size = exists ? directorySize(resolved) : { bytes: 0, truncated: false };
  return {
    root: resolved,
    exists,
    current: current ? path.resolve(current) === resolved : false,
    hasData: fs.existsSync(config) || fs.existsSync(state),
    writable: exists ? (() => { try { fs.accessSync(resolved, fs.constants.W_OK); return true; } catch { return false; } })() : false,
    bytes: size.bytes,
    truncated: size.truncated,
    storeId: configStoreId(resolved),
    accounts: accountsOf(resolved),
    locked,
  };
}

/**
 * A switch is recorded as pending and executed on the next start, so no file is
 * copied while the store is writing to it.
 */
export function planSwitch(home, { target, mode, confirm = false }) {
  if (typeof target !== 'string' || !target.trim() || target.length > 4000 || !path.isAbsolute(target.trim()))
    throw new ChannelError('INVALID_STORAGE_PATH', '请填写完整的数据目录绝对路径');
  const resolved = path.resolve(target.trim());
  if (resolved === path.parse(resolved).root) throw new ChannelError('INVALID_STORAGE_PATH', '请选择具体文件夹，不能使用磁盘根目录');
  const location = readLocation(home);
  if (location?.root === resolved) throw new ChannelError('DATA_ROOT_UNCHANGED', '当前已经在使用这个数据目录');
  if (mode !== 'use' && mode !== 'copy') throw new ChannelError('INVALID_REQUEST', '请选择迁移方式');
  const source = location?.root ?? path.resolve(home);
  if (resolved === source) throw new ChannelError('DATA_ROOT_UNCHANGED', '当前已经在使用这个数据目录');
  // Copying a directory into itself (or into its own parent) would make the copy
  // walk its own output forever, so both directions are refused for "copy".
  if (mode === 'copy' && (withinDirectory(source, resolved) || withinDirectory(resolved, source)))
    throw new ChannelError(
      'DATA_ROOT_OVERLAP',
      '新数据目录不能与当前数据目录互相包含；请选择另一个独立文件夹，否则复制会无限嵌套并写满磁盘');
  const described = describeDataRoot(resolved, { current: source });
  if (described.locked)
    throw new ChannelError('DATA_ROOT_LOCKED', '这个数据目录正被另一个微信 Agent 或 DSH 插件使用，请先退出后再切换');
  if (mode === 'copy' && !fs.existsSync(source))
    throw new ChannelError('DATA_ROOT_SOURCE_MISSING', '当前数据目录不存在，无法复制；可以改用“直接使用”方式');
  const currentAccounts = accountsOf(source);
  const sharedAccounts = described.accounts.filter((id) => currentAccounts.includes(id));
  const otherAccounts = described.accounts.filter((id) => !currentAccounts.includes(id));
  // One WeChat account owns one set of records, so a directory that holds the
  // same account is the intended way to share data between the two ends. Only a
  // directory that belongs to a different account asks for a second confirmation.
  // Copy is included: writing this account's files into another account's
  // directory produces a mixed root that no later switch can untangle.
  if (described.hasData && currentAccounts.length && !sharedAccounts.length && !confirm)
    throw new ChannelError(
      'DATA_ROOT_OTHER_ACCOUNT',
      mode === 'copy'
        ? `这个目录属于另一个微信账号${otherAccounts[0] ? '（' + otherAccounts[0] + '）' : ''}；复制会把当前账号的数据写进去形成混合目录，如果确实要复制请再确认一次`
        : `这个目录属于另一个微信账号${otherAccounts[0] ? '（' + otherAccounts[0] + '）' : ''}；如果确实要改用请再确认一次，否则请用一个空目录或与当前账号相同的目录`);
  return { target: resolved, mode, source, accounts: described.accounts, currentAccounts, sharedAccounts, otherAccounts };
}

export function applySwitch(home, plan) {
  const location = readLocation(home);
  // Keep an unreadable pointer next to the new one: it is the only evidence of
  // where the data used to live.
  if (location?.corrupt) {
    try { fs.renameSync(locationFile(home), locationFile(home) + '.corrupt'); } catch { /* Writing the new pointer matters more. */ }
  }
  return writeLocation(home, {
    root: location?.root ?? path.resolve(home),
    storeId: location?.storeId,
    pending: { mode: plan.mode, target: plan.target, source: plan.source, at: new Date().toISOString() },
  });
}

function copyTree(source, target, { skip } = {}) {
  let bytes = 0;
  const stack = [['', source]];
  while (stack.length) {
    const [relative, current] = stack.pop();
    // A recursive tree can only be produced by a mistake (a nested target or a
    // reparse point); refuse instead of filling the disk.
    if (relative.split(path.posix.sep).length > 64) throw new ChannelError('DATA_ROOT_OVERLAP', '目录层级过深，已停止复制');
    const destination = relative ? path.join(target, relative) : target;
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (skip(entry.name, relative)) continue;
      const from = path.join(current, entry.name), to = path.join(destination, entry.name);
      if (entry.isDirectory()) stack.push([path.posix.join(relative, entry.name), from]);
      else if (entry.isSymbolicLink()) continue;
      else { fs.copyFileSync(from, to); bytes += fs.statSync(to).size; if (bytes > MAX_BYTES) throw new ChannelError('DATA_ROOT_TOO_LARGE', '数据目录超过 8 GB，已停止复制'); }
    }
  }
  return bytes;
}

/**
 * Runs on startup, before the store opens. Copy first, then publish the pointer;
 * a failure keeps the previous root and records why.
 */
export function resolveDataRoot(home) {
  const location = readLocation(home);
  if (!location) return { root: path.resolve(home), source: 'default' };
  if (location.corrupt) return { root: path.resolve(home), source: 'default', corrupted: true };
  if (!location.pending) return { root: location.root, storeId: location.storeId, source: 'pointer' };
  const { mode, target, source: from } = location.pending;
  const destination = typeof target === 'string' && path.isAbsolute(target) ? path.resolve(target) : undefined;
  const origin = typeof from === 'string' && path.isAbsolute(from) ? from : location.root;
  // Only a directory this run created may be removed again on failure; an
  // existing directory belongs to the owner and is never deleted.
  const created = destination ? !fs.existsSync(destination) : false;
  try {
    if (!destination) throw new ChannelError('INVALID_STORAGE_PATH', '数据目录路径无效');
    if (destination === path.parse(destination).root) throw new ChannelError('INVALID_STORAGE_PATH', '不能使用磁盘根目录');
    if (mode === 'copy' && (withinDirectory(origin, destination) || withinDirectory(destination, origin)))
      throw new ChannelError('DATA_ROOT_OVERLAP', '新数据目录与当前数据目录互相包含，已停止复制');
    const described = describeDataRoot(destination, { current: location.root });
    if (described.locked) throw new ChannelError('DATA_ROOT_LOCKED', '目标数据目录正被另一个实例使用');
    if (mode === 'copy') {
      if (!fs.existsSync(origin)) throw new ChannelError('DATA_ROOT_SOURCE_MISSING', '原数据目录不存在');
      copyTree(origin, destination, { skip: (name) => VOLATILE.has(name) });
    } else fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    writeLocation(home, { root: destination, storeId: described.storeId });
    return { root: destination, source: mode === 'copy' ? 'copied' : 'switched', storeId: described.storeId };
  } catch (error) {
    if (created && destination) {
      try { fs.rmSync(destination, { recursive: true, force: true }); } catch { /* Keep the failure report. */ }
    }
    writeLocation(home, {
      root: location.root,
      storeId: location.storeId,
      lastSwitchError: (error?.message || '切换数据目录失败') + '；已继续使用原来的数据目录',
    });
    return { root: location.root, storeId: location.storeId, source: 'failed', error: error?.message };
  }
}

/** Where the DSH plugin keeps its pointer; the file is shared by both ends. */
export function dshLocationFile(dshHome) {
  return dshHome ? path.join(path.resolve(dshHome), 'wechat-agent', LOCATION_FILE) : undefined;
}

export function pluginRoot(dshHome) {
  const file = dshLocationFile(dshHome);
  if (!file) return undefined;
  const value = readJSON(file);
  if (!value || typeof value.root !== 'string' || !path.isAbsolute(value.root)) return undefined;
  return { root: path.resolve(value.root), storeId: value.storeId };
}
