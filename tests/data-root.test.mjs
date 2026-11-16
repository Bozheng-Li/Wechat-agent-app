import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accountsOf,
  applySwitch,
  describeDataRoot,
  lockHolder,
  planSwitch,
  pluginRoot,
  readLocation,
  resolveDataRoot,
  writeLocation,
} from '../backend/storage/data-root.mjs';

const temporary = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function rootWithData(storeId, files = {}, accounts = []) {
  const directory = temporary('wa-root-');
  const accountBlock = accounts.map((id) => `  ${id}:\n    enabled: true\n`).join('');
  fs.writeFileSync(path.join(directory, 'config.yaml'),
    accounts.length
      ? `version: 1\nownerStoreId: ${storeId}\naccounts:\n${accountBlock}`
      : `version: 1\nownerStoreId: ${storeId}\naccounts: {}\n`);
  fs.mkdirSync(path.join(directory, 'storage/state'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'storage/state/channel.json'), '{"version":2}\n');
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return directory;
}

test('数据目录指针缺失时用应用自己的目录，损坏时明确标记而不是静默回落', () => {
  const home = temporary('wa-home-');
  assert.equal(readLocation(home), undefined);
  assert.deepEqual(resolveDataRoot(home), { root: path.resolve(home), source: 'default' });
  fs.writeFileSync(path.join(home, 'location.json'), '{ broken');
  // 损坏的指针仍然不能阻止启动，但必须如实报告：静默回落后用户再也找不到真实目录。
  assert.deepEqual(readLocation(home), { corrupt: true });
  assert.deepEqual(resolveDataRoot(home), { root: path.resolve(home), source: 'default', corrupted: true });
  fs.writeFileSync(path.join(home, 'location.json'), JSON.stringify({ version: 1, root: 'relative/path' }));
  assert.equal(readLocation(home).corrupt, true);
  assert.equal(resolveDataRoot(home).source, 'default');
  // 下一次切换前把损坏的指针留档，避免覆盖唯一的线索。
  const target = path.join(home, 'moved');
  fs.mkdirSync(target, { recursive: true });
  applySwitch(home, planSwitch(home, { target, mode: 'use' }));
  assert.equal(fs.existsSync(path.join(home, 'location.json.corrupt')), true);
});

test('切换数据目录前校验路径、占用与已有数据', () => {
  const home = temporary('wa-home-');
  const current = rootWithData('store-a');
  writeLocation(home, { root: current, storeId: 'store-a' });
  assert.throws(() => planSwitch(home, { target: 'relative', mode: 'use' }), { code: 'INVALID_STORAGE_PATH' });
  assert.throws(() => planSwitch(home, { target: current, mode: 'use' }), { code: 'DATA_ROOT_UNCHANGED' });
  assert.throws(() => planSwitch(home, { target: temporary('wa-empty-'), mode: 'later' }), { code: 'INVALID_REQUEST' });
  const other = rootWithData('store-b');
  assert.equal(planSwitch(home, { target: other, mode: 'use' }).mode, 'use', '当前目录还没有账号时可以直接改用');
  assert.equal(planSwitch(home, { target: other, mode: 'copy' }).mode, 'copy');
  const locked = temporary('wa-locked-');
  fs.writeFileSync(path.join(locked, 'owner.lock'), JSON.stringify({ pid: process.pid, token: 'x' }));
  assert.throws(() => planSwitch(home, { target: locked, mode: 'use' }), { code: 'DATA_ROOT_LOCKED' });
  assert.equal(describeDataRoot(locked).locked.pid, process.pid);
});

test('同一个微信账号的目录可以直接共用，不同账号才需要再次确认', () => {
  const home = temporary('wa-home-');
  const current = rootWithData('store-a', {}, ['wxid_same']);
  writeLocation(home, { root: current, storeId: 'store-a' });
  const same = rootWithData('store-b', {}, ['wxid_same']);
  const plan = planSwitch(home, { target: same, mode: 'use' });
  assert.deepEqual(plan.sharedAccounts, ['wxid_same']);
  assert.deepEqual(plan.otherAccounts, []);
  const foreign = rootWithData('store-c', {}, ['wxid_other']);
  assert.throws(() => planSwitch(home, { target: foreign, mode: 'use' }), { code: 'DATA_ROOT_OTHER_ACCOUNT' });
  const confirmed = planSwitch(home, { target: foreign, mode: 'use', confirm: true });
  assert.deepEqual(confirmed.otherAccounts, ['wxid_other']);
  assert.deepEqual(accountsOf(foreign), ['wxid_other']);
  assert.deepEqual(describeDataRoot(foreign).accounts, ['wxid_other']);
});

test('直接使用在下次启动生效，并清掉待执行的切换', () => {
  const home = temporary('wa-home-');
  const current = rootWithData('store-a');
  const target = temporary('wa-target-');
  writeLocation(home, { root: current, storeId: 'store-a' });
  applySwitch(home, planSwitch(home, { target, mode: 'use' }));
  assert.equal(readLocation(home).root, path.resolve(current), '待执行期间仍使用原目录');
  const result = resolveDataRoot(home);
  assert.equal(result.source, 'switched');
  assert.equal(result.root, path.resolve(target));
  assert.equal(readLocation(home).root, path.resolve(target));
  assert.equal(readLocation(home).pending, undefined);
  assert.equal(fs.existsSync(target), true);
});

test('复制迁移保留配置与记录，跳过缓存和实例锁', () => {
  const home = temporary('wa-home-');
  const current = rootWithData('store-a', {
    'Cache/data_0': 'cache',
    'owner.lock': JSON.stringify({ pid: 999999, token: 'x' }),
    'workspace/微信agent/note.txt': 'hello',
    'credentials/key.bin': 'cipher',
  });
  const target = temporary('wa-target-');
  writeLocation(home, { root: current, storeId: 'store-a' });
  applySwitch(home, planSwitch(home, { target, mode: 'copy' }));
  const result = resolveDataRoot(home);
  assert.equal(result.source, 'copied');
  assert.equal(fs.readFileSync(path.join(target, 'config.yaml'), 'utf8').includes('store-a'), true);
  assert.equal(fs.readFileSync(path.join(target, 'storage/state/channel.json'), 'utf8'), '{"version":2}\n');
  assert.equal(fs.readFileSync(path.join(target, 'workspace/微信agent/note.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(target, 'credentials/key.bin'), 'utf8'), 'cipher');
  assert.equal(fs.existsSync(path.join(target, 'Cache')), false);
  assert.equal(fs.existsSync(path.join(target, 'owner.lock')), false);
});

test('目标目录被占用或复制失败时继续使用原目录并记录原因', () => {
  const home = temporary('wa-home-');
  const current = rootWithData('store-a');
  const target = temporary('wa-target-');
  fs.writeFileSync(path.join(target, 'owner.lock'), JSON.stringify({ pid: process.pid, token: 'x' }));
  writeLocation(home, { root: current, storeId: 'store-a' });
  fs.writeFileSync(path.join(home, 'location.json'), JSON.stringify({
    version: 1, root: path.resolve(current), storeId: 'store-a',
    pending: { mode: 'copy', target, source: path.resolve(current), at: new Date().toISOString() },
  }));
  const result = resolveDataRoot(home);
  assert.equal(result.source, 'failed');
  assert.equal(result.root, path.resolve(current));
  assert.match(readLocation(home).lastSwitchError, /原来的数据目录/);
  assert.equal(readLocation(home).pending, undefined);
});

test('复制到当前目录内部或外部父目录时直接拒绝，不会递归复制自身', () => {
  const home = temporary('wa-home-');
  const current = rootWithData('store-a');
  writeLocation(home, { root: current, storeId: 'store-a' });
  const nested = path.join(current, 'backup');
  assert.throws(() => planSwitch(home, { target: nested, mode: 'copy' }), { code: 'DATA_ROOT_OVERLAP' });
  const parent = path.dirname(path.resolve(current));
  assert.throws(() => planSwitch(home, { target: parent, mode: 'copy' }), { code: 'DATA_ROOT_OVERLAP' });
  // "use" may point inside the current directory: nothing is copied.
  assert.equal(planSwitch(home, { target: nested, mode: 'use' }).mode, 'use');
  // A pending copy recorded by an older version is rechecked on startup and the
  // directory it created is removed again instead of being published.
  fs.writeFileSync(path.join(home, 'location.json'), JSON.stringify({
    version: 1, root: path.resolve(current), storeId: 'store-a',
    pending: { mode: 'copy', target: nested, source: path.resolve(current), at: new Date().toISOString() },
  }));
  const result = resolveDataRoot(home);
  assert.equal(result.source, 'failed');
  assert.match(readLocation(home).lastSwitchError, /互相包含/);
  assert.equal(fs.existsSync(nested), false, '失败后不留下半成品目录');
  assert.equal(fs.readFileSync(path.join(current, 'config.yaml'), 'utf8').includes('store-a'), true);
});

test('识别 DSH 插件记录的数据目录，供两端共用', () => {
  const dshHome = temporary('wa-dsh-');
  assert.equal(pluginRoot(dshHome), undefined);
  const root = rootWithData('store-a');
  fs.mkdirSync(path.join(dshHome, 'wechat-agent'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'wechat-agent/location.json'),
    JSON.stringify({ version: 1, root, storeId: 'store-a' }));
  assert.deepEqual(pluginRoot(dshHome), { root: path.resolve(root), storeId: 'store-a' });
  assert.equal(describeDataRoot(root).hasData, true);
});

test('启动前的占用检查只认仍存活的实例锁', () => {
  const free = temporary('wa-free-');
  assert.equal(lockHolder(free), undefined);
  const stale = temporary('wa-stale-');
  fs.writeFileSync(path.join(stale, 'owner.lock'), JSON.stringify({ pid: 999999, workerPid: 999998 }));
  assert.equal(lockHolder(stale), undefined, '进程已退出时锁视为过期');
  const live = temporary('wa-live-');
  fs.writeFileSync(path.join(live, 'owner.lock'), JSON.stringify({ pid: process.pid, workerPid: 999998 }));
  assert.deepEqual(lockHolder(live), { pid: process.pid, workerPid: 999998 });
  assert.deepEqual(describeDataRoot(live).locked, { pid: process.pid, workerPid: 999998 });
});
