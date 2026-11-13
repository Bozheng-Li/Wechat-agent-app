'use strict';
// Update checks and downloads stay in the main process: the renderer has no
// network access (connect-src 'none') and must never handle the installer bytes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const RELEASE = { owner: 'Bozheng-Li', repo: 'Wechat-agent-app' };
const RELEASE_PAGE = `https://github.com/${RELEASE.owner}/${RELEASE.repo}/releases/latest`;
const DEFAULT_FEED = `https://github.com/${RELEASE.owner}/${RELEASE.repo}/releases/latest/download/latest.yml`;
// /releases/latest skips prereleases and every build here is a preview, so the
// release list is consulted when the stable feed is missing.
const RELEASES_API = `https://api.github.com/repos/${RELEASE.owner}/${RELEASE.repo}/releases?per_page=10`;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.exe$/;

class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

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
  let latest = null, controller = null, downloading = false, installed = null;

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
    const hash = crypto.createHash('sha512');
    controller = new AbortController();
    downloading = true;
    let received = 0, reportedAt = 0;
    const report = (total, force = false) => {
      const now = Date.now();
      if (!force && now - reportedAt < 150) return;
      reportedAt = now;
      onProgress({ received, total: total || latest.size || 0, percent: percentOf(received, total || latest.size) });
    };
    try {
      let response;
      try {
        response = await fetchImpl(latest.fileURL, { headers: { accept: '*/*' }, redirect: 'follow', cache: 'no-store', signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw new UpdateError('UPDATE_CANCELLED', '已取消下载');
        throw new UpdateError('UPDATE_DOWNLOAD_FAILED', '下载更新包失败，请检查网络后重试');
      }
      if (!response || !response.ok || !response.body) throw new UpdateError('UPDATE_DOWNLOAD_FAILED', '更新包地址不可用');
      const total = Number(response.headers?.get?.('content-length')) || latest.size || 0;
      report(total, true);
      const stream = Readable.fromWeb(response.body);
      const counter = new Transform({
        transform(chunk, _encoding, done) {
          received += chunk.length;
          hash.update(chunk);
          report(total);
          done(null, chunk);
        },
      });
      await pipeline(stream, counter, fs.createWriteStream(partial));
      report(total, true);
      const digest = hash.digest('base64');
      if (latest.sha512 && digest !== latest.sha512) {
        throw new UpdateError('UPDATE_HASH_MISMATCH', '更新包校验失败，已丢弃下载内容');
      }
      if (latest.size && received !== latest.size) throw new UpdateError('UPDATE_HASH_MISMATCH', '更新包大小不符，已丢弃下载内容');
      fs.rmSync(target, { force: true });
      fs.renameSync(partial, target);
      installed = target;
      return { path: target, size: received, version: latest.version, percent: 100 };
    } catch (error) {
      fs.rmSync(partial, { force: true });
      if (error instanceof UpdateError) throw error;
      if (controller.signal.aborted) throw new UpdateError('UPDATE_CANCELLED', '已取消下载');
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
