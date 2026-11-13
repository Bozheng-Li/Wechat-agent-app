import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareVersions, parseLatest, createUpdater, UpdateError, DEFAULT_FEED, RELEASES_API } = require('../desktop/updates.cjs');

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
