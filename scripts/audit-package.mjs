import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { assertPackagePath, packageFiles, packageResources } from './package-resources.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const REQUIRED_RUNTIME_FILES = Object.freeze([
  'ui/app.js', 'ui/index.html', 'runtime/python/python.exe', 'runtime/python/python313.zip', 'runtime/python/python313._pth',
  'runtime/native_engine.py', 'runtime/native_login_worker.py', 'runtime/native_login_agent.js',
  'runtime/wechat39-engine/manifest.json', 'licenses/react/LICENSE',
]);

/** Freeze the exact inputs before invoking the builder, not after it finishes. */
export function capturePackage(source, config) {
  packageResources(source, config);
  const files = packageFiles(source, config);
  for (const file of REQUIRED_RUNTIME_FILES) assert(files.includes(file), 'Missing required runtime input: ' + file);
  const engine = JSON.parse(fs.readFileSync(path.join(source, 'runtime/wechat39-engine/manifest.json'), 'utf8'));
  assert(Array.isArray(engine.files) && engine.files.length, 'Missing native engine file manifest');
  for (const file of engine.files) {
    assert(typeof file.name === 'string' && !/[\\/]/.test(file.name) && file.name !== '.' && file.name !== '..', 'Invalid native engine manifest path');
    const relative = 'runtime/wechat39-engine/' + file.name;
    assert(files.includes(relative), 'Missing native engine input: ' + file.name);
    const bytes = fs.readFileSync(path.join(source, relative));
    assert.equal(bytes.length, file.bytes, 'Native engine size mismatch: ' + file.name);
    assert.equal(hash(path.join(source, relative)), file.sha256, 'Native engine hash mismatch: ' + file.name);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-wechat-app');
  assert.equal(manifest.main, 'desktop/main.cjs');
  assert(!Object.keys(manifest.dependencies || {}).length && !Object.keys(manifest.optionalDependencies || {}).length,
    'Bundled app must not auto-package dependencies');
  return Object.freeze({ name: manifest.name, version: manifest.version, main: manifest.main,
    files: Object.freeze(Object.fromEntries(files.map(file => [file, hash(path.join(source, file))]))) });
}

/** Walk the real package, rejecting unlisted files/links before reading content. */
export function auditPackage(packaged, snapshot) {
  packaged = path.resolve(packaged);
  assert(!fs.lstatSync(packaged).isSymbolicLink(), 'Linked packaged app directory');
  const actual = [], queue = [''];
  while (queue.length) {
    const directory = queue.pop();
    for (const entry of fs.readdirSync(path.join(packaged, directory), { withFileTypes: true })) {
      const file = directory ? directory + '/' + entry.name : entry.name;
      assertPackagePath(file, entry.isDirectory());
      assert(!entry.isSymbolicLink(), `Linked packaged input: ${file}`);
      if (entry.isDirectory()) { queue.push(file); continue; }
      assert(entry.isFile(), `Not a packaged file: ${file}`);
      assert(Object.hasOwn(snapshot.files, file), `Unexpected packaged file: ${file}`);
      actual.push(file);
    }
  }
  assert.deepEqual(actual.sort(), Object.keys(snapshot.files).sort(), 'Actual packaged file list differs from build inputs');
  for (const file of actual) {
    // electron-builder deliberately strips development package metadata.
    if (file !== 'package.json') assert.equal(hash(path.join(packaged, file)), snapshot.files[file], 'Packaged bytes differ from build inputs: ' + file);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(packaged, 'package.json'), 'utf8'));
  for (const key of ['name', 'version', 'main']) assert.equal(manifest[key], snapshot[key], `Packaged ${key} differs from build inputs`);
  assert.equal(manifest.dsh, undefined, 'Harness metadata must not ship');
  assert(!Object.keys(manifest.dependencies || {}).length && !Object.keys(manifest.optionalDependencies || {}).length, 'Unexpected packaged dependencies');
  return actual;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appDirectory = process.argv.find(value => value.startsWith('--app-dir='))?.slice(10);
  const packaged = appDirectory ? path.resolve(appDirectory) : path.join(root, 'release/win-unpacked/resources/app');
  const files = auditPackage(packaged, capturePackage(root));
  console.log(`Package audit passed: ${files.length} actual files match approved build inputs; no private/development files.`);
}
