import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareVersions, parseLatest, createUpdater, UpdateError, DEFAULT_FEED, RELEASES_API } = require('../desktop/updates.cjs');
const { parseBlockmap, blockLayout, planDelta } = require('../desktop/blockmap.cjs');

const sha512 = bytes => crypto.createHash('sha512').update(bytes).digest('base64');

function latestYml({ version, name, bytes }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512(bytes)}`,
    `    size: ${bytes.length}`,
    `path: ${name}`,
    `sha512: ${sha512(bytes)}`,
    'releaseDate: \'2026-11-13T02:56:03.343Z\'',
  ].join('\n');
}

async function feedServer({ yml, file, name }) {
  const server = http.createServer((request, response) => {
    if (request.url === '/download/latest.yml') { response.writeHead(200); response.end(yml); return; }
    if (request.url === '/download/' + encodeURIComponent(name)) { response.writeHead(200, { 'content-length': file.length }); response.end(file); return; }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/download/latest.yml` };
}

test('version comparison follows semver ordering including prereleases', () => {
  const cases = [
    ['0.1.2-preview.1', '0.1.1-preview.1', 1],
    ['0.1.1-preview.2', '0.1.1-preview.1', 1],
    ['0.1.1', '0.1.1-preview.1', 1],
    ['v0.1.1-preview.1', '0.1.1-preview.1', 0],
    ['0.1.1-preview.10', '0.1.1-preview.9', 1],
    ['0.1.1-preview.beta', '0.1.1-preview.1', 1],
    ['0.0.9', '0.1.0', -1],
  ];
  for (const [left, right, expected] of cases) assert.equal(compareVersions(left, right), expected, `${left} vs ${right}`);
  assert.equal(compareVersions('0.1.1+build.7', '0.1.1'), 0);
  assert.throws(() => compareVersions('preview', '0.1.1'), { code: 'UPDATE_VERSION_INVALID' });
});

test('latest.yml parsing keeps only a Windows installer payload', () => {
  const bytes = Buffer.from('installer');
  const feed = parseLatest(latestYml({ version: '0.1.2-preview.1', name: 'Wechat-Agent-App-0.1.2-preview.1-Setup.exe', bytes }));
  assert.equal(feed.version, '0.1.2-preview.1');
  assert.equal(feed.fileName, 'Wechat-Agent-App-0.1.2-preview.1-Setup.exe');
  assert.equal(feed.size, bytes.length);
  assert.equal(feed.sha512, sha512(bytes));
  assert.equal(feed.releaseDate, '2026-11-13T02:56:03.343Z');
  assert.throws(() => parseLatest(''), { code: 'UPDATE_FEED_INVALID' });
  assert.throws(() => parseLatest('version: 0.1.2'), { code: 'UPDATE_FEED_INVALID' });
  assert.throws(() => parseLatest('version: 0.1.2\npath: notes.zip'), { code: 'UPDATE_FEED_INVALID' });
  // A feed can name a file but never a location: only the base name is kept.
  assert.equal(parseLatest('version: 0.1.2\npath: ../../evil.exe').fileName, 'evil.exe');
});

test('check reports a newer release and matches the current version without claiming an update', async t => {
  const bytes = Buffer.from('installer-bytes');
  const name = 'Wechat-Agent-App-0.1.2-preview.1-Setup.exe';
  const feed = await feedServer({ yml: latestYml({ version: '0.1.2-preview.1', name, bytes }), file: bytes, name });
  t.after(() => feed.server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-update-check-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const updater = createUpdater({ currentVersion: '0.1.1-preview.1', feedURL: feed.url, directory });
  const found = await updater.check();
  assert.equal(found.status, 'available');
  assert.equal(found.version, '0.1.2-preview.1');
  assert.equal(found.size, bytes.length);
  const same = createUpdater({ currentVersion: '0.1.2-preview.1', feedURL: feed.url, directory });
  assert.equal((await same.check()).status, 'current');
  assert.throws(() => createUpdater({ currentVersion: 'unknown', feedURL: feed.url, directory }), { code: 'UPDATE_VERSION_INVALID' });
});

test('check turns an unreachable feed into a short retryable error', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-update-offline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const updater = createUpdater({ currentVersion: '0.1.1-preview.1', feedURL: 'http://127.0.0.1:1/latest.yml', directory });
  await assert.rejects(updater.check(), { code: 'UPDATE_FEED_UNREACHABLE' });
  const broken = createUpdater({
    currentVersion: '0.1.1-preview.1',
    feedURL: 'http://127.0.0.1:1/latest.yml',
    directory,
    fetchImpl: async () => ({ ok: true, text: async () => 'version: nope' }),
  });
  await assert.rejects(broken.check(), { code: 'UPDATE_FEED_INVALID' });
});

test('download verifies the installer digest, reports progress and only installs that file', async t => {
  const bytes = crypto.randomBytes(96 * 1024);
  const name = 'Wechat-Agent-App-0.1.2-preview.1-Setup.exe';
  const feed = await feedServer({ yml: latestYml({ version: '0.1.2-preview.1', name, bytes }), file: bytes, name });
  t.after(() => feed.server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-update-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const updater = createUpdater({ currentVersion: '0.1.1-preview.1', feedURL: feed.url, directory });
  const seen = [];
  const result = await updater.download(progress => seen.push(progress));
  assert.equal(result.size, bytes.length);
  assert.equal(result.version, '0.1.2-preview.1');
  assert.deepEqual(fs.readFileSync(result.path), bytes);
  assert.equal(fs.existsSync(result.path + '.part'), false);
  assert.equal(seen.at(-1).percent, 100);
  assert.ok(seen.length >= 2, 'progress is reported more than once');
  const launched = [];
  const install = updater.install(result.path, (target, args, options) => {
    launched.push({ target, args, options });
    return { unref() {} };
  });
  assert.equal(install.launched, true);
  assert.equal(launched[0].target, result.path);
  assert.equal(launched[0].options.detached, true);
  assert.throws(() => updater.install(path.join(directory, 'other.exe'), () => ({ unref() {} })), { code: 'UPDATE_NO_PACKAGE' });
  assert.throws(() => createUpdater({ currentVersion: '0.1.2-preview.1', feedURL: feed.url, directory }).install(), { code: 'UPDATE_NO_PACKAGE' });
});

test('a mismatched installer is rejected and leaves nothing behind', async t => {
  const name = 'Wechat-Agent-App-0.1.2-preview.1-Setup.exe';
  const served = Buffer.from('real-installer');
  const yml = latestYml({ version: '0.1.2-preview.1', name, bytes: Buffer.from('expected-installer') });
  const feed = await feedServer({ yml, file: served, name });
  t.after(() => feed.server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-update-hash-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const updater = createUpdater({ currentVersion: '0.1.1-preview.1', feedURL: feed.url, directory });
  await assert.rejects(updater.download(), { code: 'UPDATE_HASH_MISMATCH' });
  assert.deepEqual(fs.readdirSync(path.join(directory, 'updates')), []);
  assert.throws(() => updater.install(), { code: 'UPDATE_NO_PACKAGE' });
});

test('a missing stable feed falls back to the published release list', async t => {
  const bytes = Buffer.from('preview-installer');
  const name = 'Wechat-Agent-App-0.2.0-preview.1-Setup.exe';
  const asset = 'https://example.test/releases/download/v0.2.0-preview.1/latest.yml';
  const page = 'https://example.test/releases/tag/v0.2.0-preview.1';
  const calls = [];
  const fetchImpl = async address => {
    calls.push(address);
    if (address === DEFAULT_FEED) return new Response('Not Found', { status: 404 });
    if (address === RELEASES_API) return new Response(JSON.stringify([
      { tag_name: 'v0.1.0-preview.1', draft: false, html_url: 'https://example.test/old', assets: [] },
      { tag_name: 'v0.3.0-preview.1', draft: true, html_url: 'https://example.test/draft', assets: [{ name: 'latest.yml', browser_download_url: 'https://example.test/draft/latest.yml' }] },
      { tag_name: 'v0.2.0-preview.1', draft: false, html_url: page, assets: [{ name: 'latest.yml', browser_download_url: asset }] },
    ]), { status: 200 });
    if (address === asset) return new Response(latestYml({ version: '0.2.0-preview.1', name, bytes }), { status: 200 });
    return new Response('', { status: 404 });
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-update-fallback-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const updater = createUpdater({ currentVersion: '0.1.2-preview.1', feedURL: DEFAULT_FEED, fetchImpl, directory });
  const result = await updater.check();
  assert.equal(result.status, 'available');
  assert.equal(result.version, '0.2.0-preview.1');
  assert.equal(result.size, bytes.length);
  assert.equal(result.pageURL, page);
  assert.deepEqual(calls, [DEFAULT_FEED, RELEASES_API, asset], 'drafts and releases without a feed are skipped');
  assert.equal(updater.state().version, '0.2.0-preview.1');
});

test('an explicit feed is reported as-is without falling back', async t => {
  const calls = [];
  const fetchImpl = async address => { calls.push(address); throw new Error('offline'); };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-update-explicit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const updater = createUpdater({ currentVersion: '0.1.2-preview.1', feedURL: 'http://127.0.0.1:9/latest.yml', fetchImpl, directory });
  await assert.rejects(updater.check(), error => error instanceof UpdateError && error.code === 'UPDATE_FEED_UNREACHABLE');
  assert.deepEqual(calls, ['http://127.0.0.1:9/latest.yml']);
});

test('a release list without a feed asset keeps the original error', async t => {
  const fetchImpl = async address => address === RELEASES_API
    ? new Response(JSON.stringify([{ tag_name: 'v0.2.0-preview.1', draft: false, assets: [{ name: 'Setup.exe', browser_download_url: 'https://example.test/Setup.exe' }] }]), { status: 200 })
    : new Response('', { status: 404 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-update-empty-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const updater = createUpdater({ currentVersion: '0.1.2-preview.1', feedURL: DEFAULT_FEED, fetchImpl, directory });
  await assert.rejects(updater.check(), { code: 'UPDATE_FEED_UNREACHABLE' });
});

// ---- differential updates ---------------------------------------------------
// Every fixture is built here: a synthetic blockmap is just gzipped JSON whose
// checksums are only ever compared as strings by the code under test.
const BLOCK = 1024;

function blockmapOf(bytes, blockSize = BLOCK) {
  const checksums = [], sizes = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const end = Math.min(offset + blockSize, bytes.length);
    checksums.push(crypto.createHash('sha512').update(bytes.subarray(offset, end)).digest('base64').slice(0, 24));
    sizes.push(end - offset);
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify({
    version: 2,
    files: [{ name: 'Setup.exe', offset: 0, checksums, sizes }],
  })));
}

function gzipped(value) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value)));
}

function seedPrevious({ directory, name, bytes, version, blockmap }) {
  const updates = path.join(directory, 'updates');
  fs.mkdirSync(updates, { recursive: true });
  fs.writeFileSync(path.join(updates, name), bytes);
  fs.writeFileSync(path.join(updates, name + '.blockmap'), blockmap);
  fs.writeFileSync(path.join(updates, 'cache.json'), JSON.stringify({
    entries: [{ version, fileName: name, size: bytes.length, sha512: sha512(bytes), fileURL: 'https://example.test/old/' + name, blockmapFile: '' }],
  }, null, 2));
  return updates;
}

// A mock feed that answers Range requests with real slices and counts bytes.
function deltaFetch({ yml, feedURL, fileURL, served, blockmaps, releases = null, range = 'slice', stall = false }) {
  const stats = { rangeBytes: 0, fullBytes: 0, rangeRequests: 0, fullRequests: 0 };
  const fetchImpl = async (address, init = {}) => {
    const requested = String(init.headers?.range || '');
    if (address === feedURL) return new Response(yml, { status: 200 });
    if (address === RELEASES_API) {
      if (!releases) return new Response('', { status: 404 });
      return new Response(JSON.stringify(releases), { status: 200 });
    }
    if (blockmaps.has(address)) return new Response(blockmaps.get(address), { status: 200 });
    if (address !== fileURL) return new Response('', { status: 404 });
    if (!requested) {
      stats.fullRequests += 1; stats.fullBytes += served.length;
      return new Response(served, { status: 200, headers: { 'content-length': String(served.length) } });
    }
    stats.rangeRequests += 1;
    if (stall) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (range === 'ignore') {
      stats.fullBytes += served.length;
      return new Response(served, { status: 200, headers: { 'content-length': String(served.length) } });
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(requested);
    if (!match) return new Response('', { status: 416 });
    const start = Number(match[1]), end = Number(match[2]) + 1;
    const slice = served.subarray(start, end);
    stats.rangeBytes += slice.length;
    return new Response(slice, { status: 206, headers: { 'content-length': String(slice.length) } });
  };
  return { fetchImpl, stats };
}

function prepareDelta(t, { oldBytes, oldBlockmap, served } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-update-delta-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = crypto.randomBytes(4 * BLOCK);
  const prior = oldBytes || Buffer.concat([bytes.subarray(0, BLOCK), crypto.randomBytes(BLOCK), bytes.subarray(2 * BLOCK)]);
  const oldName = 'Wechat-Agent-App-0.1.6-Setup.exe';
  const newName = 'Wechat-Agent-App-0.1.7-preview.2-Setup.exe';
  const updates = seedPrevious({ directory, name: oldName, bytes: prior, version: '0.1.6', blockmap: oldBlockmap || blockmapOf(prior) });
  const feedURL = 'https://example.test/releases/download/v0.1.7-preview.2/latest.yml';
  const fileURL = 'https://example.test/releases/download/v0.1.7-preview.2/' + newName;
  const blockmaps = new Map([[fileURL + '.blockmap', blockmapOf(bytes)]]);
  return { directory, updates, bytes, prior, oldBlockmap: oldBlockmap || blockmapOf(prior),
    served: served || bytes, yml: latestYml({ version: '0.1.7-preview.2', name: newName, bytes }),
    feedURL, fileURL, blockmaps, oldName, newName };
}

test('a missing cached blockmap is recovered from the release list', async t => {
  const fixture = prepareDelta(t);
  fs.rmSync(path.join(fixture.updates, fixture.oldName + '.blockmap'));
  const oldURL = 'https://example.test/releases/download/v0.1.6/' + fixture.oldName + '.blockmap';
  const { fetchImpl, stats } = deltaFetch({
    ...fixture,
    blockmaps: new Map([...fixture.blockmaps, [oldURL, fixture.oldBlockmap]]),
    releases: [{ tag_name: 'v0.1.6', draft: false, html_url: 'https://example.test/tag/v0.1.6',
      assets: [{ name: fixture.oldName + '.blockmap', browser_download_url: oldURL }] }],
  });
  const updater = createUpdater({ currentVersion: '0.1.6', feedURL: fixture.feedURL, fetchImpl, directory: fixture.directory });
  const result = await updater.download();
  assert.equal(result.differential.used, true);
  assert.equal(stats.fullRequests, 0);
  assert.deepEqual(fs.readFileSync(result.path), fixture.bytes);
  assert.ok(fs.existsSync(path.join(fixture.updates, fixture.oldName + '.blockmap')), 'the recovered blockmap is cached');
});

test('blockmap plans copy identical blocks and coalesce changed ones into one range', () => {
  const bytes = crypto.randomBytes(4 * BLOCK);
  const layout = blockLayout(parseBlockmap(blockmapOf(bytes)));
  assert.equal(layout.size, bytes.length);
  assert.deepEqual(layout.offsets, [0, BLOCK, 2 * BLOCK, 3 * BLOCK]);
  const same = planDelta(layout, blockLayout(parseBlockmap(blockmapOf(bytes))));
  assert.equal(same.fetch.length, 0);
  assert.equal(same.reusedBytes, bytes.length);
  assert.equal(same.fetchBytes, 0);
  // One replaced block becomes a single range covering exactly that block.
  const oneChanged = Buffer.from(bytes);
  crypto.randomBytes(BLOCK).copy(oneChanged, BLOCK);
  const single = planDelta(layout, blockLayout(parseBlockmap(blockmapOf(oneChanged))));
  assert.deepEqual(single.fetch, [{ start: BLOCK, end: 2 * BLOCK, size: BLOCK }]);
  assert.equal(single.copy.length, 3);
  assert.equal(single.reusedBytes, 3 * BLOCK);
  // Two neighbouring blocks must merge instead of producing two requests.
  const twoChanged = Buffer.from(bytes);
  crypto.randomBytes(2 * BLOCK).copy(twoChanged, BLOCK);
  const merged = planDelta(layout, blockLayout(parseBlockmap(blockmapOf(twoChanged))));
  assert.deepEqual(merged.fetch, [{ start: BLOCK, end: 3 * BLOCK, size: 2 * BLOCK }]);
  // Nothing in common is not a delta at all.
  const unrelated = blockLayout(parseBlockmap(blockmapOf(crypto.randomBytes(4 * BLOCK))));
  assert.throws(() => planDelta(layout, unrelated), { code: 'DELTA_NO_GAIN' });
  // Malformed blockmaps are rejected instead of being guessed at.
  assert.throws(() => parseBlockmap(Buffer.from('not a blockmap')), { code: 'BLOCKMAP_INVALID' });
  assert.throws(() => parseBlockmap(gzipped({ version: 1, files: [] })), { code: 'BLOCKMAP_INVALID' });
  // electron-builder emits the version as a string; both spellings must parse.
  assert.equal(parseBlockmap(gzipped({ version: '2', files: [{ name: 'a.exe', checksums: ['a'.repeat(24)], sizes: [BLOCK] }] })).version, 2);
  assert.throws(() => parseBlockmap(gzipped({ version: 3, files: [] })), { code: 'BLOCKMAP_INVALID' });
  assert.throws(() => parseBlockmap(gzipped({ version: 2, files: [] })), { code: 'BLOCKMAP_INVALID' });
  assert.throws(() => parseBlockmap(gzipped({ version: 2, files: [{ checksums: [], sizes: [] }] })), { code: 'BLOCKMAP_INVALID' });
  assert.throws(() => parseBlockmap(gzipped({ version: 2, files: [{ checksums: ['a'.repeat(24)], sizes: [0] }] })), { code: 'BLOCKMAP_INVALID' });
  assert.throws(() => parseBlockmap(gzipped({ version: 2, files: [{ checksums: ['short'], sizes: [BLOCK] }] })), { code: 'BLOCKMAP_INVALID' });
  assert.throws(() => parseBlockmap(gzipped({ version: 2, files: [{ checksums: ['a'.repeat(24)], sizes: [BLOCK, BLOCK] }] })), { code: 'BLOCKMAP_INVALID' });
});

test('a differential download reuses cached blocks and only fetches the gaps', async t => {
  const fixture = prepareDelta(t);
  const { fetchImpl, stats } = deltaFetch(fixture);
  const updater = createUpdater({ currentVersion: '0.1.6', feedURL: fixture.feedURL, fetchImpl, directory: fixture.directory });
  const seen = [];
  const result = await updater.download(progress => seen.push(progress));
  assert.equal(result.differential.used, true);
  assert.equal(result.differential.savedBytes, 3 * BLOCK);
  assert.equal(result.differential.fetchedBytes, BLOCK);
  assert.equal(stats.fullRequests, 0, 'the installer is never downloaded in full');
  assert.equal(stats.rangeBytes, BLOCK);
  assert.ok(stats.rangeBytes < fixture.bytes.length / 2);
  assert.equal(result.size, fixture.bytes.length);
  assert.equal(result.version, '0.1.7-preview.2');
  assert.deepEqual(fs.readFileSync(result.path), fixture.bytes);
  assert.equal(fs.existsSync(result.path + '.part'), false);
  assert.equal(seen.at(-1).percent, 100);
  assert.equal(updater.state().differential.used, true);
  const cache = JSON.parse(fs.readFileSync(path.join(fixture.updates, 'cache.json'), 'utf8'));
  assert.equal(cache.entries.length, 2);
  assert.equal(cache.entries[0].fileName, fixture.newName);
  assert.equal(cache.entries[0].blockmapFile, fixture.fileURL + '.blockmap');
  assert.ok(fs.existsSync(path.join(fixture.updates, fixture.newName + '.blockmap')), 'the new blockmap is cached for the next release');
});

test('a server that ignores Range falls back to one full download', async t => {
  const fixture = prepareDelta(t);
  const { fetchImpl, stats } = deltaFetch({ ...fixture, range: 'ignore' });
  const updater = createUpdater({ currentVersion: '0.1.6', feedURL: fixture.feedURL, fetchImpl, directory: fixture.directory });
  const result = await updater.download();
  assert.equal(result.differential.used, false);
  assert.equal(stats.rangeRequests, 1);
  assert.equal(stats.fullRequests, 1);
  assert.deepEqual(fs.readFileSync(result.path), fixture.bytes);
  assert.equal(fs.existsSync(result.path + '.part'), false);
  assert.equal(updater.state().differential.used, false);
});

test('a differential assembly that fails its digest falls back to a full download', async t => {
  // The old installer is corrupt but its cached blockmap still claims the new
  // checksums, so the copy phase produces bytes that cannot pass sha512.
  const bytes = crypto.randomBytes(4 * BLOCK);
  const corrupt = Buffer.from(bytes);
  crypto.randomBytes(BLOCK).copy(corrupt, BLOCK);
  const fixture = prepareDelta(t, { oldBytes: corrupt, oldBlockmap: blockmapOf(bytes) });
  const { fetchImpl, stats } = deltaFetch(fixture);
  const updater = createUpdater({ currentVersion: '0.1.6', feedURL: fixture.feedURL, fetchImpl, directory: fixture.directory });
  const result = await updater.download();
  assert.equal(result.differential.used, false);
  assert.equal(stats.rangeRequests, 0);
  assert.equal(stats.fullRequests, 1);
  assert.deepEqual(fs.readFileSync(result.path), fixture.bytes);
  assert.equal(fs.existsSync(result.path + '.part'), false);
});

test('cancelling a differential download reports UPDATE_CANCELLED and keeps nothing', async t => {
  const fixture = prepareDelta(t);
  const { fetchImpl, stats } = deltaFetch({ ...fixture, stall: true });
  const updater = createUpdater({ currentVersion: '0.1.6', feedURL: fixture.feedURL, fetchImpl, directory: fixture.directory });
  const pending = assert.rejects(updater.download(), { code: 'UPDATE_CANCELLED' });
  await new Promise(resolve => setTimeout(resolve, 60));
  updater.cancel();
  await pending;
  assert.equal(stats.rangeRequests, 1, 'the differential path had already started');
  assert.equal(fs.existsSync(path.join(fixture.updates, fixture.newName)), false);
  assert.equal(fs.existsSync(path.join(fixture.updates, fixture.newName + '.part')), false);
  assert.equal(updater.state().downloading, false);
});
