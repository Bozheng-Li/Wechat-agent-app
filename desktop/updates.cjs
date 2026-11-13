'use strict';
// Update checks and downloads stay in the main process: the renderer has no
// network access (connect-src 'none') and must never handle the installer bytes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { parseBlockmap, blockLayout, planDelta, BlockmapError } = require('./blockmap.cjs');

const RELEASE = { owner: 'Bozheng-Li', repo: 'Wechat-agent-app' };
const RELEASE_PAGE = `https://github.com/${RELEASE.owner}/${RELEASE.repo}/releases/latest`;
const DEFAULT_FEED = `https://github.com/${RELEASE.owner}/${RELEASE.repo}/releases/latest/download/latest.yml`;
// /releases/latest skips prereleases and every build here is a preview, so the
// release list is consulted when the stable feed is missing.
const RELEASES_API = `https://api.github.com/repos/${RELEASE.owner}/${RELEASE.repo}/releases?per_page=10`;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.exe$/;

// Differential downloads are an optimisation with a hard fallback: the settled
// installer always comes from a verified full download when anything is unclear.
const CACHE_FILE = 'cache.json';
const CACHE_LIMIT = 2;
const COPY_CHUNK = 1024 * 1024;
const YIELD_CHUNK = 4 * 1024 * 1024;
const BLOCKMAP_TIMEOUT = 30000;
const MAX_BLOCKMAP_BYTES = 8 * 1024 * 1024;
const MIN_REUSE = 0.05;

class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

// Internal only: the differential attempt cannot be trusted, so the caller
// discards the partial file and downloads the installer once, in full.
class DeltaFallback extends Error {}

function normalizeVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '');
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(normalizeVersion(value));
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

// Returns -1, 0 or 1. Semver ordering: numeric identifiers compare numerically,
// alpha identifiers compare by ASCII, and a release outranks its prereleases.
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw new UpdateError('UPDATE_VERSION_INVALID', '版本号格式无法识别');
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const one = a.prerelease[index], two = b.prerelease[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    if (one === two) continue;
    const numeric = /^\d+$/, oneNumeric = numeric.test(one), twoNumeric = numeric.test(two);
    if (oneNumeric && twoNumeric) return Number(one) > Number(two) ? 1 : -1;
    if (oneNumeric !== twoNumeric) return oneNumeric ? -1 : 1;
    return one > two ? 1 : -1;
  }
  return 0;
}

// electron-builder writes latest.yml. Read only the fields this app needs and
// reject anything that does not look like a Windows installer payload.
function parseLatest(text) {
  if (typeof text !== 'string' || !text.trim()) throw new UpdateError('UPDATE_FEED_INVALID', '更新信息为空');
  const scalar = key => {
    const match = new RegExp(`^${key}:[ \\t]*['"]?([^'"\\r\\n]+)['"]?[ \\t]*$`, 'm').exec(text);
    return match ? match[1].trim() : '';
  };
  const version = normalizeVersion(scalar('version'));
  if (!parseVersion(version)) throw new UpdateError('UPDATE_FEED_INVALID', '更新信息缺少可用的版本号');
  const files = [];
  const filesBlock = /^files:[ \t]*\r?\n((?:[ \t]+.*\r?\n?)+)/m.exec(text);
  if (filesBlock) {
    let current = null;
    for (const line of filesBlock[1].split(/\r?\n/)) {
      const item = /^[ \t]*-[ \t]*url:[ \t]*['"]?([^'"]+)['"]?[ \t]*$/.exec(line);
      if (item) { current = { url: item[1].trim(), sha512: '', size: 0 }; files.push(current); continue; }
      if (!current) continue;
      const field = /^[ \t]+(sha512|size):[ \t]*['"]?([^'"\r\n]+)['"]?[ \t]*$/.exec(line);
      if (field) current[field[1]] = field[1] === 'size' ? Number(field[2]) : field[2].trim();
    }
  }
  const primary = files[0] || { url: scalar('path'), sha512: scalar('sha512'), size: Number(scalar('size') || 0) };
  if (!primary.url) throw new UpdateError('UPDATE_FEED_INVALID', '更新信息缺少安装包地址');
  if (!/\.exe$/i.test(primary.url)) throw new UpdateError('UPDATE_FEED_INVALID', '更新包不是 Windows 安装程序');
  // latest.yml uses download URLs relative to the feed file itself.
  const fileName = path.basename(primary.url.split('?')[0]);
  if (!PACKAGE_NAME.test(fileName)) throw new UpdateError('UPDATE_FEED_INVALID', '更新包名称不可用');
  return {
    version,
    fileName,
    size: Number(primary.size) || 0,
    sha512: primary.sha512,
    releaseDate: scalar('releaseDate'),
  };
}

function percentOf(received, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}

function sha512File(file) {
  const hash = crypto.createHash('sha512');
  const buffer = Buffer.allocUnsafe(COPY_CHUNK);
  const fd = fs.openSync(file, 'r');
  try {
    let position = 0, read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('base64');
}

// A blockmap probe must never hang the update, and its deadline must be a
// fallback rather than a cancellation of the whole download.
function withDeadline(signal, timeout) {
  const deadline = AbortSignal.timeout(timeout);
  if (!signal) return deadline;
  if (typeof AbortSignal.any === 'function') {
    try { return AbortSignal.any([signal, deadline]); } catch {}
  }
  return signal;
}

function cancelled() {
  return new UpdateError('UPDATE_CANCELLED', '已取消下载');
}

// electron-builder publishes the blockmap as a sibling asset of the installer,
// so the address is `<fileURL>.blockmap`. Building it through URL keeps any
// query string of the download link intact.
function siblingBlockmap(address) {
  try {
    const url = new URL(address);
    url.pathname += '.blockmap';
    return url.href;
  } catch {
    return address + '.blockmap';
  }
}

// Finds the newest published release that carries a latest.yml asset and returns
// the feed address plus its release page. Returns null when the list is unusable.
async function resolveFeed(fetchImpl, timeout) {
  const response = await fetchImpl(RELEASES_API, {
    headers: { accept: 'application/vnd.github+json', 'cache-control': 'no-cache' },
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response || !response.ok) return null;
  const list = await response.json().catch(() => null);
  if (!Array.isArray(list)) return null;
  const releases = list
    .filter(item => item && !item.draft && Array.isArray(item.assets))
    .map(item => ({ ...item, version: normalizeVersion(item.tag_name || item.name) }))
    .filter(item => parseVersion(item.version))
    .sort((left, right) => compareVersions(right.version, left.version));
  for (const release of releases) {
    const asset = release.assets.find(entry => /^latest\.ya?ml$/.test(String(entry?.name || '')));
    if (typeof asset?.browser_download_url === 'string')
      return { feedURL: asset.browser_download_url, pageURL: release.html_url || RELEASE_PAGE };
  }
  return null;
}

function createUpdater({
  currentVersion,
  feedURL = process.env.WECHAT_APP_UPDATE_FEED || DEFAULT_FEED,
  fetchImpl = globalThis.fetch,
  directory,
  timeout = 20000,
} = {}) {
  if (typeof currentVersion !== 'string' || !parseVersion(currentVersion))
    throw new UpdateError('UPDATE_VERSION_INVALID', '当前版本号不可用');
  if (!directory) throw new Error('createUpdater requires a directory for downloads');
  const updates = path.join(directory, 'updates');
  let latest = null, controller = null, downloading = false, installed = null, latestDifferential = null;

  const headers = { 'accept': 'text/yaml, text/plain, */*', 'cache-control': 'no-cache' };

  async function readFeed(address) {
    let response;
    try {
      response = await fetchImpl(address, { headers, redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new UpdateError('UPDATE_FEED_UNREACHABLE', '暂时无法连接更新服务，请稍后再试');
    }
    if (!response || !response.ok) throw new UpdateError('UPDATE_FEED_UNREACHABLE', '更新服务返回了异常状态');
    let text;
    try { text = await response.text(); } catch { throw new UpdateError('UPDATE_FEED_INVALID', '更新信息读取失败'); }
    return parseLatest(text);
  }

  // ---- installed-version cache -------------------------------------------------
  // Only the two newest installers are kept so a later release can be assembled
  // from the previous one without growing the user's disk without bound.
  function readCache() {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(updates, CACHE_FILE), 'utf8')); } catch { return []; }
    if (!data || !Array.isArray(data.entries)) return [];
    return data.entries.filter(entry => entry && typeof entry === 'object'
      && typeof entry.version === 'string' && typeof entry.fileName === 'string'
      && PACKAGE_NAME.test(entry.fileName));
  }

  function writeCache(entries) {
    const kept = new Set(entries.map(entry => entry.fileName));
    for (const entry of readCache()) {
      if (kept.has(entry.fileName)) continue;
      fs.rmSync(path.join(updates, entry.fileName), { force: true });
      fs.rmSync(path.join(updates, entry.fileName + '.blockmap'), { force: true });
    }
    try {
      fs.writeFileSync(path.join(updates, CACHE_FILE), JSON.stringify({ entries }, null, 2), 'utf8');
    } catch {}
  }

  function rememberDownload({ version, fileName, size, sha512, fileURL, blockmapFile }) {
    const entry = { version, fileName, size, sha512: sha512 || '', fileURL: fileURL || '', blockmapFile: blockmapFile || '' };
    const entries = [entry, ...readCache().filter(item => item.fileName !== fileName)].slice(0, CACHE_LIMIT);
    writeCache(entries);
  }

  async function fetchBlockmapBuffer(address, signal) {
    const response = await fetchImpl(address, {
      headers: { accept: '*/*' },
      redirect: 'follow',
      cache: 'no-store',
      signal: withDeadline(signal, BLOCKMAP_TIMEOUT),
    });
    if (!response || !response.ok) throw new BlockmapError('BLOCKMAP_INVALID', 'blockmap 地址不可用');
    let body;
    try { body = Buffer.from(await response.arrayBuffer()); } catch { throw new BlockmapError('BLOCKMAP_INVALID', 'blockmap 读取失败'); }
    if (!body.length || body.length > MAX_BLOCKMAP_BYTES) throw new BlockmapError('BLOCKMAP_INVALID', 'blockmap 大小异常');
    return body;
  }

  // The old layout is looked up locally first, then from the recorded asset URL,
  // then from the public release list. Every miss ends the attempt quietly.
  async function releaseBlockmapUrls(fileName) {
    try {
      const response = await fetchImpl(RELEASES_API, {
        headers: { accept: 'application/vnd.github+json', 'cache-control': 'no-cache' },
        redirect: 'follow',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeout),
      });
      if (!response || !response.ok) return [];
      const list = await response.json().catch(() => null);
      if (!Array.isArray(list)) return [];
      const wanted = fileName + '.blockmap', found = [];
      for (const release of list) {
        if (!release || release.draft || !Array.isArray(release.assets)) continue;
        const asset = release.assets.find(item => String(item?.name || '') === wanted);
        if (typeof asset?.browser_download_url === 'string') found.push(asset.browser_download_url);
      }
      return found;
    } catch {
      return [];
    }
  }

  async function loadOldLayout(entry, oldPath) {
    const cachedFile = path.join(updates, entry.fileName + '.blockmap');
    try {
      return blockLayout(parseBlockmap(fs.readFileSync(cachedFile)));
    } catch {}
    const addresses = [];
    if (typeof entry.blockmapFile === 'string' && /^https?:\/\//i.test(entry.blockmapFile)) addresses.push(entry.blockmapFile);
    addresses.push(...await releaseBlockmapUrls(entry.fileName));
    for (const address of addresses) {
      let buffer;
      try {
        buffer = await fetchBlockmapBuffer(address, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw cancelled();
        continue;
      }
      try {
        const layout = blockLayout(parseBlockmap(buffer));
        try { fs.writeFileSync(cachedFile, buffer); } catch {}
        return layout;
      } catch {
        continue;
      }
    }
    if (controller.signal.aborted) throw cancelled();
    throw new DeltaFallback('旧版 blockmap 不可用');
  }

  // ---- differential download --------------------------------------------------
  // Writes the new installer by copying reused blocks from the old file and
  // fetching only the gaps. Any doubt throws DeltaFallback and the caller wipes
  // the partial file before falling back to one full download.
  async function assemble({ plan, oldPath, partial, target, expected, total, report }) {
    let oldFd, partFd;
    let copied = 0, fetched = 0, sinceYield = 0;
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    try {
      oldFd = fs.openSync(oldPath, 'r');
      partFd = fs.openSync(partial, 'w');
      for (const item of plan.copy) {
        let done = 0;
        while (done < item.size) {
          if (controller.signal.aborted) throw cancelled();
          const want = Math.min(buffer.length, item.size - done);
          const read = fs.readSync(oldFd, buffer, 0, want, item.from + done);
          if (read !== want) throw new DeltaFallback('旧安装包读取不完整');
          fs.writeSync(partFd, buffer, 0, read, item.to + done);
          done += read; copied += read; sinceYield += read;
          report(copied + fetched, total);
          // Copying hundreds of megabytes must not starve the main process, or
          // a cancel click would only be handled after the whole copy.
          if (sinceYield >= YIELD_CHUNK) {
            sinceYield = 0;
            await new Promise(resolve => setImmediate(resolve));
          }
        }
      }
      for (const range of plan.fetch) {
        if (controller.signal.aborted) throw cancelled();
        let response;
        try {
          response = await fetchImpl(latest.fileURL, {
            headers: { accept: '*/*', range: `bytes=${range.start}-${range.end - 1}` },
            redirect: 'follow',
            cache: 'no-store',
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted) throw cancelled();
          throw new DeltaFallback('增量请求失败');
        }
        if (controller.signal.aborted) throw cancelled();
        // 200 means the range was ignored, and any other status is not a slice.
        if (!response || response.status !== 206) throw new DeltaFallback('服务器未返回分段内容');
        const length = Number(response.headers?.get?.('content-length'));
        if (!response.body || !Number.isFinite(length) || length !== range.size)
          throw new DeltaFallback('分段响应长度不符');
        const reader = response.body.getReader();
        let offset = range.start, complete = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (controller.signal.aborted) throw cancelled();
            const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            if (offset + chunk.length > range.end) throw new DeltaFallback('分段响应超出范围');
            fs.writeSync(partFd, chunk, 0, chunk.length, offset);
            offset += chunk.length; fetched += chunk.length;
            report(copied + fetched, total);
          }
          complete = true;
        } finally {
          // A range that ends early must not leave the response half read.
          if (!complete) { try { await reader.cancel(); } catch {} }
        }
        if (offset !== range.end) throw new DeltaFallback('分段响应不完整');
      }
    } finally {
      if (partFd !== undefined) { try { fs.closeSync(partFd); } catch {} }
      if (oldFd !== undefined) { try { fs.closeSync(oldFd); } catch {} }
    }
    if (controller.signal.aborted) throw cancelled();
    if (fs.statSync(partial).size !== expected) throw new DeltaFallback('增量组装大小不符');
    if (latest.sha512 && sha512File(partial) !== latest.sha512) throw new DeltaFallback('增量组装校验失败');
    fs.rmSync(target, { force: true });
    fs.renameSync(partial, target);
    installed = target;
    report(total, total, true);
    return { savedBytes: plan.reusedBytes, fetchedBytes: fetched };
  }

  async function attemptDifferential({ target, partial, report }) {
    const usable = readCache().filter(entry => entry.fileName !== latest.fileName
      && fs.existsSync(path.join(updates, entry.fileName)));
    if (!usable.length) return null;
    const wanted = normalizeVersion(currentVersion);
    const old = usable.find(entry => normalizeVersion(entry.version) === wanted) || usable[0];
    const oldPath = path.join(updates, old.fileName);
    const oldLayout = await loadOldLayout(old, oldPath);
    if (fs.statSync(oldPath).size !== oldLayout.size) throw new DeltaFallback('旧安装包大小与 blockmap 不符');
    const buffer = await fetchBlockmapBuffer(siblingBlockmap(latest.fileURL), controller.signal);
    const newLayout = blockLayout(parseBlockmap(buffer));
    if (latest.size && newLayout.size !== latest.size) throw new DeltaFallback('新 blockmap 与安装包大小不符');
    const plan = planDelta(oldLayout, newLayout);
    if (plan.reusedBytes / newLayout.size < MIN_REUSE) throw new DeltaFallback('可复用分块太少');
    const total = latest.size || newLayout.size;
    const result = await assemble({
      plan, oldPath, partial, target, expected: newLayout.size, total, report,
    });
    return { ...result, blockmap: buffer };
  }

  // ---- full download ----------------------------------------------------------
  async function downloadFull({ target, partial, report }) {
    let response;
    try {
      response = await fetchImpl(latest.fileURL, { headers: { accept: '*/*' }, redirect: 'follow', cache: 'no-store', signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw cancelled();
      throw new UpdateError('UPDATE_DOWNLOAD_FAILED', '下载更新包失败，请检查网络后重试');
    }
    if (!response || !response.ok || !response.body) throw new UpdateError('UPDATE_DOWNLOAD_FAILED', '更新包地址不可用');
    const total = Number(response.headers?.get?.('content-length')) || latest.size || 0;
    const hash = crypto.createHash('sha512');
    let received = 0;
    report(0, total, true);
    const stream = Readable.fromWeb(response.body);
    const counter = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        hash.update(chunk);
        report(received, total);
        done(null, chunk);
      },
    });
    await pipeline(stream, counter, fs.createWriteStream(partial));
    report(received, total, true);
    const digest = hash.digest('base64');
    if (latest.sha512 && digest !== latest.sha512) {
      throw new UpdateError('UPDATE_HASH_MISMATCH', '更新包校验失败，已丢弃下载内容');
    }
    if (latest.size && received !== latest.size) throw new UpdateError('UPDATE_HASH_MISMATCH', '更新包大小不符，已丢弃下载内容');
    fs.rmSync(target, { force: true });
    fs.renameSync(partial, target);
    installed = target;
    return received;
  }

  // Storing the new blockmap is what makes the next release differential; it is
  // always best effort and must never turn a finished download into a failure.
  async function storeBlockmap(destination, buffer) {
    try {
      const body = buffer || await fetchBlockmapBuffer(siblingBlockmap(latest.fileURL), controller?.signal);
      fs.writeFileSync(destination, body);
    } catch {}
  }

  async function check() {
    let feed, source = feedURL, page = RELEASE_PAGE;
    try {
      feed = await readFeed(source);
    } catch (error) {
      // An explicitly configured feed is never second-guessed.
      if (source !== DEFAULT_FEED) throw error;
      const fallback = await resolveFeed(fetchImpl, timeout).catch(() => null);
      if (!fallback) throw error;
      ({ feedURL: source, pageURL: page } = fallback);
      feed = await readFeed(source);
    }
    const available = compareVersions(feed.version, currentVersion) > 0;
    latestDifferential = null;
    latest = available
      ? { ...feed, fileURL: new URL(feed.fileName, source).href, pageURL: page, status: 'available' }
      : { ...feed, status: 'current' };
    return {
      status: latest.status,
      currentVersion: normalizeVersion(currentVersion),
      version: feed.version,
      releaseDate: feed.releaseDate,
      size: feed.size,
      pageURL: page,
    };
  }

  async function download(onProgress = () => {}) {
    if (downloading) throw new UpdateError('UPDATE_BUSY', '更新包正在下载');
    if (!latest || latest.status !== 'available') await check();
    if (!latest || latest.status !== 'available') throw new UpdateError('UPDATE_NOT_AVAILABLE', '当前已是最新版本');
    fs.mkdirSync(updates, { recursive: true });
    const target = path.join(updates, latest.fileName), partial = target + '.part';
    controller = new AbortController();
    downloading = true;
    latestDifferential = null;
    let reportedAt = 0;
    const report = (value, total, force = false) => {
      const now = Date.now();
      if (!force && now - reportedAt < 150) return;
      reportedAt = now;
      onProgress({ received: value, total: total || latest.size || 0, percent: percentOf(value, total || latest.size) });
    };
    let differential = { used: false };
    try {
      let outcome = null;
      try {
        outcome = await attemptDifferential({ target, partial, report });
      } catch (error) {
        fs.rmSync(partial, { force: true });
        if (error instanceof UpdateError && error.code === 'UPDATE_CANCELLED') throw error;
        if (controller.signal.aborted) throw cancelled();
        outcome = null; // any doubt: the full path below is authoritative
      }
      const size = outcome ? fs.statSync(target).size : await downloadFull({ target, partial, report });
      if (outcome) {
        differential = { used: true, savedBytes: outcome.savedBytes, fetchedBytes: outcome.fetchedBytes };
        report(size, latest.size || size, true);
      }
      rememberDownload({
        version: latest.version,
        fileName: latest.fileName,
        size,
        sha512: latest.sha512 || '',
        fileURL: latest.fileURL || '',
        blockmapFile: latest.fileURL ? siblingBlockmap(latest.fileURL) : '',
      });
      await storeBlockmap(target + '.blockmap', outcome?.blockmap);
      latestDifferential = differential;
      return { path: target, size, version: latest.version, percent: 100, differential };
    } catch (error) {
      fs.rmSync(partial, { force: true });
      if (error instanceof UpdateError) throw error;
      if (controller.signal.aborted) throw cancelled();
      throw new UpdateError('UPDATE_DOWNLOAD_FAILED', '下载更新包时出错，请重试');
    } finally {
      downloading = false;
      controller = null;
    }
  }

  function cancel() {
    controller?.abort();
    return { cancelled: true };
  }

  function state() {
    return {
      status: latest?.status || 'idle',
      version: latest?.version || '',
      downloaded: installed,
      downloading,
      differential: latestDifferential,
    };
  }

  return {
    check,
    download,
    cancel,
    state,
    get currentVersion() { return normalizeVersion(currentVersion); },
    get feedURL() { return feedURL; },
    get releasePage() { return RELEASE_PAGE; },
    // The installer runs on first paint of its own window; the app then quits.
    install(target = installed, spawnImpl = spawn) {
      if (!target || !fs.existsSync(target)) throw new UpdateError('UPDATE_NO_PACKAGE', '还没有下载更新包');
      if (path.resolve(path.dirname(target)) !== path.resolve(updates)) throw new UpdateError('UPDATE_NO_PACKAGE', '更新包位置不可用');
      const child = spawnImpl(target, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref?.();
      return { launched: true, path: target };
    },
  };
}

module.exports = {
  RELEASE, RELEASE_PAGE, DEFAULT_FEED, RELEASES_API, UpdateError,
  normalizeVersion, parseVersion, compareVersions, parseLatest, resolveFeed, createUpdater, percentOf,
};
