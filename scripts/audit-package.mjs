import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = process.argv.find(value => value.startsWith('--app-dir='))?.slice(10);
const packaged = appDirectory ? path.resolve(appDirectory) : path.join(root, 'release/win-unpacked/resources/app');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const file of ['lib/app.js', 'lib/worker.cjs', 'ui/app.js', 'ui/index.html', 'desktop/main.cjs', 'desktop/network.cjs', 'desktop/preload.cjs', 'desktop/updates.cjs',
  'config.yaml', 'CHANGELOG.md', 'README.md', 'docs/development.md', 'docs/validation.md', 'docs/images/hero.svg', 'docs/images/overview.png', 'docs/images/models.png',
  'runtime/python/python.exe', 'runtime/python/python313.zip', 'runtime/python/python313._pth',
  'runtime/native_engine.py', 'runtime/native_login_worker.py', 'runtime/native_login_agent.js'])
  assert.equal(hash(path.join(root, file)), hash(path.join(packaged, file)), 'Packaged bytes differ: ' + file);
const manifest = JSON.parse(fs.readFileSync(path.join(packaged, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'dsh-wechat-app'); assert.equal(manifest.dsh, undefined);
for (const name of ['storage', 'credentials', 'providers.json', '.git', 'tests', 'node_modules', '.env', '.env.local', 'lib/testing.js'])
  assert.equal(fs.existsSync(path.join(packaged, name)), false, 'Private/development input in package: ' + name);
const engine = JSON.parse(fs.readFileSync(path.join(packaged, 'runtime/wechat39-engine/manifest.json'), 'utf8'));
for (const file of engine.files) assert.equal(hash(path.join(packaged, 'runtime/wechat39-engine', file.name)), file.sha256);
assert.ok(fs.readFileSync(path.join(packaged, 'config.yaml'), 'utf8').includes('connectionWanted: false'));
assert.ok(fs.existsSync(path.join(packaged, 'licenses/react/LICENSE')));
console.log('Package audit passed: verified runtime, self-contained app, no account data or development files.');
