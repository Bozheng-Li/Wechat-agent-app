import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readDocx, receivedFileAccess, wechatFileTool, workModelTools,
  StateStore, WorkStore, WechatChannel, ChannelError, workOutcome, workReply } from '../lib/testing.js';
import { planProgressiveTools } from '../modules/tools/progressive.mjs';
import { CAPABILITY_SUMMARIES } from '../prompts/agent/capabilities.mjs';
import { wordFixture } from './fixtures/word.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const signal = () => new AbortController().signal;
const source = { messageId: '18446744073709551001', name: '需求.docx', senderId: 'alice', senderName: '阿禾', time: 1700000000000 };
const scope = { accountId: 'fixture-self', chatType: 'private', peerId: 'alice', senderId: 'alice', requestedAt: Date.now() };
function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-file-tools-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function fixture({ data = wordFixture(), files, loaded, latestUnavailable = false, assertAllowed = () => {}, saveInput } = {}) {
  const calls = [], row = { ...source, bytes: data.length, resourceId: sha('fixture-source') }, operations = [];
  const transport = { files: async (query, requestSignal) => {
    calls.push({ query, signal: requestSignal });
    assert.equal(query.accountId, scope.accountId); assert.equal(query.peerId, scope.peerId); assert.equal(query.before, scope.requestedAt);
    if (query.action === 'list') return { files: files ?? [row], ...(latestUnavailable ? { latestUnavailable: true } : {}) };
    return loaded ? loaded(data, query) : { ...row, data: data.toString('base64'), sha256: sha(data) };
  } };
  const access = receivedFileAccess(transport, scope), tool = wechatFileTool({ access, assertAllowed, saveInput, onOperation: async operation => operations.push(operation) });
  return { calls, access, tool, data, operations, invoke: async (args, requestSignal = signal()) => JSON.parse(await tool.execute(args, { signal: requestSignal })) };
}

test('Word extraction preserves Chinese text, entities, emoji and table row/column order', () => {
  const value = readDocx(wordFixture({ text: 'Q782 <需求> & 😀', table: [['项目', '数值'], ['预算', '42'], ['时间', '周五']] }));
  assert.equal(value.text, 'Q782 <需求> & 😀\n项目\t数值\n预算\t42\n时间\t周五');
  assert.equal(value.tables, 1); assert.equal(value.paragraphs, 7); assert.match(value.note, /图片.*未/);
});

test('Word read ignores field instructions and deleted revisions while retaining displayed hyperlinks and line breaks', () => {
  const body = '<w:p><w:del><w:r><w:delText>old secret</w:delText></w:r></w:del><w:r><w:instrText>DO NOT EXECUTE</w:instrText><w:t>当前</w:t><w:tab/><w:t>版本</w:t><w:br/></w:r><w:hyperlink><w:r><w:t>链接文字</w:t></w:r></w:hyperlink></w:p>';
  const result = readDocx(wordFixture({ body }));
  assert.equal(result.text, '当前\t版本\n链接文字'); assert(!result.text.includes('EXECUTE')); assert(!result.text.includes('secret'));
});

test('damaged, encrypted, duplicate-member, non-DOCX and oversized XML inputs fail explicitly', () => {
  assert.throws(() => readDocx(Buffer.from('legacy-doc-or-pdf')), { code: 'FILE_DOCX_INVALID' });
  const broken = wordFixture(); broken[100] ^= 0x01; assert.throws(() => readDocx(broken), { code: 'FILE_DOCX_INVALID' });
  const encrypted = wordFixture(); encrypted.writeUInt16LE(0x801, 6); assert.throws(() => readDocx(encrypted), { code: 'FILE_DOCX_INVALID' });
  assert.throws(() => readDocx(wordFixture({ extra: [{ name: 'word/document.xml', text: '<bad/>' }] })), { code: 'FILE_DOCX_INVALID' });
  assert.throws(() => readDocx(wordFixture({ body: '<!DOCTYPE x [<!ENTITY leak "bad">]><w:p/>' })), { code: 'FILE_DOCX_INVALID' });
  assert.throws(() => readDocx(wordFixture({ extra: [{ name: '../outside.xml', text: 'outside' }] })), { code: 'FILE_DOCX_INVALID' });
  const oversized = wordFixture(), at = oversized.indexOf(Buffer.from('word/document.xml'), oversized.indexOf(Buffer.from([0x50, 0x4b, 1, 2])));
  oversized.writeUInt32LE(16 * 1024 * 1024 + 1, at - 46 + 24);
  assert.throws(() => readDocx(oversized), { code: 'FILE_DOCX_INVALID' });
});

test('list never downloads content, read verifies bytes and paginates Unicode without silent truncation', async () => {
  const originalText = '😀需求 Q782，'.repeat(1600), f = fixture({ data: wordFixture({ text: originalText, table: [] }) });
  const listed = await f.invoke({ action: 'list' }); assert.equal(listed.files[0].messageId, source.messageId); assert.equal(f.calls.length, 1);
  const first = await f.invoke({ action: 'read', messageId: source.messageId, limit: 301 });
  assert(first.ok); assert(first.text.isWellFormed()); assert(first.hasMore); assert.equal(first.returnedChars, 301);
  let text = first.text, next = first;
  while (next.hasMore) { next = await f.invoke({ action: 'read', messageId: source.messageId, offset: next.nextOffset, revision: next.revision }); assert(next.ok); text += next.text; }
  assert.equal(text, originalText); assert.equal(next.hasMore, false); assert.equal(next.nextOffset, null);
  assert.equal((await f.invoke({ action: 'read', messageId: source.messageId, offset: 1 })).code, 'FILE_READ_RANGE_INVALID');
  assert.equal((await f.invoke({ action: 'read', messageId: source.messageId, offset: 1, revision: 'f'.repeat(64) })).code, 'FILE_CHANGED');
});

test('file listing accepts bounded pagination without trying to read or download documents', async () => {
  const files = [source, { ...source, messageId: '18446744073709551002' }, { ...source, messageId: '18446744073709551003' }];
  const f = fixture({ files });
  const first = await f.invoke({ action: 'list', offset: 0, limit: 1 });
  assert(first.ok); assert.equal(first.files.length, 1); assert.equal(first.total, 3); assert.equal(first.nextOffset, 1);
  const next = await f.invoke({ action: 'list', offset: first.nextOffset, limit: 2 });
  assert(next.ok); assert.equal(next.files[0].messageId, files[1].messageId); assert.equal(next.hasMore, false);
  assert(f.calls.every(call => call.query.action === 'list'));
});

test('missing attachment bytes end retries without treating the document format as unsupported', async () => {
  const f = fixture({ files: [], latestUnavailable: true, saveInput: async () => assert.fail('missing originals cannot be saved') });
  const listed = await f.invoke({ action: 'list', limit: 10 });
  assert(listed.ok); assert.equal(listed.needsUserInput, true); assert.equal(listed.retryable, false);
  for (const action of ['read', 'download']) {
    const result = await f.invoke({ action });
    assert.equal(result.code, 'FILE_NOT_RECEIVED'); assert.equal(result.retryable, false); assert.equal(result.needsUserInput, true);
    assert.match(result.note, /不能据此判断 Word 格式不受支持/);
    assert.match(result.message, /没有收到原文件/); assert(!/查询|扫描|Word|版本不支持/.test(result.message));
  }
  assert(f.calls.every(call => call.query.action === 'list'));
  const report = workReply({ ...workOutcome('修改刚才的文档', f.operations), result: { text: '无法继续修改' } });
  assert(report.length < 100); assert(!/查询|扫描|本轮|格式不受支持/.test(report));
});

test('unobserved references and duplicate filenames never silently select the latest file', async () => {
  const f = fixture(); assert.equal((await f.invoke({ action: 'read', messageId: '1' })).code, 'FILE_NOT_FOUND');
  assert.equal((await fixture({ files: [] }).invoke({ action: 'read' })).code, 'FILE_NOT_FOUND');
  assert(f.calls.every(value => value.query.action === 'list'));
  const duplicate = fixture({ files: [source, { ...source, messageId: '18446744073709551002' }] });
  assert.equal((await duplicate.invoke({ action: 'read', name: source.name })).code, 'FILE_AMBIGUOUS');
  assert.equal(duplicate.calls.length, 1);
});

test('an unnamed request selects the newest received file and keeps it while listings change', async () => {
  const newerId = '18446744073709551003', olderId = '18446744073709551000';
  const files = [{ ...source }, { ...source, messageId: olderId }];
  const f = fixture({ files, loaded: (data, query) => ({ ...source, messageId: query.messageId, bytes: data.length, data: data.toString('base64'), sha256: sha(data) }) });
  const first = await f.invoke({ action: 'read', limit: 10 });
  assert(first.ok); assert.equal(first.messageId, source.messageId); assert.equal(first.selectedBy, 'latest');
  files.unshift({ ...source, messageId: newerId });
  const next = await f.invoke({ action: 'read', offset: first.nextOffset, revision: first.revision });
  assert(next.ok); assert.equal(next.messageId, source.messageId); assert.equal(next.selectedBy, 'current');
  assert.deepEqual(f.calls.filter(call => call.query.action === 'download').map(call => call.query.messageId), [source.messageId, source.messageId]);
  assert(f.operations.every(operation => operation.messageId === source.messageId));
});

test('after rejecting a recent candidate, an explicit older choice becomes the current file', async () => {
  const olderId = '18446744073709551000', files = [{ ...source }, { ...source, messageId: olderId, name: '较早的需求.docx' }];
  const f = fixture({ files, loaded: (data, query) => ({ ...files.find(file => file.messageId === query.messageId), bytes: data.length, data: data.toString('base64'), sha256: sha(data) }) });
  const listed = await f.invoke({ action: 'list' }); assert.deepEqual(listed.files.map(file => file.messageId), [source.messageId, olderId]);
  assert.equal(f.calls.filter(call => call.query.action === 'download').length, 0);
  const confirmed = await f.invoke({ action: 'read', messageId: olderId, limit: 10 }); assert(confirmed.ok);
  const rest = await f.invoke({ action: 'read', offset: confirmed.nextOffset, revision: confirmed.revision });
  assert(rest.ok); assert.equal(rest.messageId, olderId); assert.equal(rest.selectedBy, 'current');
  files.splice(1, 1);
  assert.equal((await f.invoke({ action: 'read' })).code, 'FILE_NOT_FOUND');
  assert(f.calls.filter(call => call.query.action === 'download').every(call => call.query.messageId === olderId));
});

test('a more recent unsupported message requires candidate confirmation before reading an older file', async () => {
  const f = fixture({ latestUnavailable: true });
  const latest = await f.invoke({ action: 'read' }); assert.equal(latest.code, 'FILE_SELECTION_UNCERTAIN');
  assert.equal(f.calls.filter(call => call.query.action === 'download').length, 0);
  const listed = await f.invoke({ action: 'list' }); assert(listed.ok); assert.equal(listed.latestUnavailable, true);
  assert.equal(listed.files[0].messageId, source.messageId);
  const confirmed = await f.invoke({ action: 'read', messageId: source.messageId }); assert(confirmed.ok); assert.equal(confirmed.contentRead, true);
  assert.equal(confirmed.selectedBy, 'messageId');
});

test('account/room/URL/path overrides are rejected before transport, and returned identity/digest are checked', async () => {
  for (const extra of [{ accountId: 'other' }, { peerId: 'other' }, { url: 'https://example.com' }, { path: '../outside.docx' }]) {
    const f = fixture(); assert.equal((await f.invoke({ action: 'read', messageId: source.messageId, ...extra })).code, 'FILE_QUERY_INVALID'); assert.equal(f.calls.length, 0);
  }
  for (const override of [{ sha256: 'f'.repeat(64) }, { messageId: '1' }, { bytes: 3 }, { name: 'wrong.docx' }, { data: 'AQ==' }]) {
    const f = fixture({ loaded: data => ({ ...source, bytes: data.length, data: data.toString('base64'), sha256: sha(data), ...override }) });
    assert.equal((await f.invoke({ action: 'read', messageId: source.messageId })).code, 'FILE_INTEGRITY_FAILED');
  }
});

test('cancellation and revoked permissions suppress file results and subsequent operations', async () => {
  let allowed = true;
  const f = fixture({ loaded: data => { allowed = false; return { ...source, bytes: data.length, data: data.toString('base64'), sha256: sha(data) }; },
    assertAllowed: () => { if (!allowed) throw new ChannelError('AUTH_CHANGED', 'revoked'); } });
  await assert.rejects(f.invoke({ action: 'read', messageId: source.messageId }), { code: 'AUTH_CHANGED' }); assert.equal(f.operations.length, 0);
  const cancelled = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.invoke({ action: 'read', messageId: source.messageId }, controller.signal), { name: 'AbortError' }); assert.equal(cancelled.calls.length, 0);
});

test('standalone work excludes retired attachments and host file execution tools', t => {
  const cwd = temporary(t), f = fixture(), operations = [];
  const definitions = workModelTools({ surface: 'native', cwd, fileAccess: f.access, assertAllowed() {}, onOperation: async row => operations.push(row),
    resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: cwd }), limits: {} });
  for (const name of ['wechat_file', 'wechat_work_output', 'wechat_work_read', 'wechat_work_write', 'wechat_work_exec', 'wechat_work_ssh_exec'])
    assert(!definitions.some(tool => tool.name === name), name);
  assert.equal(f.calls.length, 0); assert.equal(operations.length, 0);
});
