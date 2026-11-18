import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { StateStore, identity, acquireLock } = await import(process.env.DSH_STATE_TEST_MODULE || '../lib/testing.js');

// Two recovery paths that used to be permanent: an unreadable lock file and a
// leftover atomic-write temporary both blocked their directory forever, with a
// "restart the app" hint that restarts could not fix.
const account = 'wxid_owner', group = 'group_a@chatroom';
const STALE = new Date(Date.now() - 60000);

function temporary(t) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'dsh-recovery-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}
function incoming(n) {
  return { id: 'message-' + n, serverMessageId: String(n), peerId: group, chatType: 'group',
    direction: 'incoming', time: Math.floor(Date.now() / 1000), sender: { id: 'alice', nickname: 'Alice' },
    message: [{ type: 'text', data: { text: 'Question ' + n } }] };
}
function record(n) {
  const message = incoming(n);
  return { item: { key: identity([account, message.chatType, message.peerId, message.serverMessageId]),
    contextKey: identity([account, message.chatType, message.peerId, message.sender.id]), accountId: account,
    chatType: message.chatType, peerId: message.peerId, senderId: message.sender.id, sender: 'Alice',
    messageId: message.id, state: 'queued', question: 'Question ' + n, createdAt: Date.now(), updatedAt: Date.now() },
  message };
}

test('a lock file truncated by a crash is reclaimed instead of blocking startup forever', t => {
  const root = temporary(t), lock = path.join(root, 'owner.lock');
  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, STALE, STALE);
  const handle = acquireLock(root);
  assert.ok(fs.existsSync(lock), 'the new instance takes over the data root');
  handle.release();
  assert.equal(fs.existsSync(lock), false, 'release still removes its own lock');
});

test('a half-written lock that is still being created is not stolen', t => {
  const root = temporary(t), lock = path.join(root, 'owner.lock');
  fs.writeFileSync(lock, '{"pid":');
  assert.throws(() => acquireLock(root), { code: 'OWNER_BUSY' },
    'a lock younger than the grace window may belong to a writer mid-open');
  assert.ok(fs.existsSync(lock));
});

test('a live owner lock keeps the second instance out', t => {
  const root = temporary(t), lock = path.join(root, 'owner.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other' }));
  fs.utimesSync(lock, STALE, STALE);
  assert.throws(() => acquireLock(root), { code: 'OWNER_BUSY' });
  assert.ok(fs.existsSync(lock), 'an alive holder is never reaped, however old the file looks');
});

test('a leftover atomic temporary no longer blocks the first conversation write', t => {
  const root = temporary(t), store = new StateStore(root);
  store.ensureWorkspace();
  const directory = store.recordsPage(account, { chatType: 'group', peerId: group }).recordsPath;
  fs.mkdirSync(directory, { recursive: true });
  const temporaryFile = path.join(directory, 'conversation.json.1234.11111111-1111-1111-1111-111111111111.tmp');
  fs.writeFileSync(temporaryFile, '{"version":1');
  const { item, message } = record(1);
  store.remember(item.key, Date.now(), item, { accountId: account, message, progress: { count: 1, target: 5 } });
  assert.equal(fs.existsSync(temporaryFile), false, 'the stale temporary is reaped');
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'conversation.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.ok(saved.records.some((row) => row.key === item.key));
});

test('a genuinely foreign file still refuses the directory instead of overwriting it', t => {
  const root = temporary(t), store = new StateStore(root);
  store.ensureWorkspace();
  const directory = store.recordsPage(account, { chatType: 'group', peerId: group }).recordsPath;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'someone else data');
  const { item, message } = record(2);
  assert.throws(
    () => store.remember(item.key, Date.now(), item, { accountId: account, message, progress: { count: 1, target: 5 } }),
    (error) => ['CONVERSATION_PATH_CONFLICT', 'STATE_WRITE_FAILED'].includes(error.code)
  );
  assert.equal(fs.readFileSync(path.join(directory, 'notes.txt'), 'utf8'), 'someone else data');
});
