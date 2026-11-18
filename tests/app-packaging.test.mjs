import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capturePackage, auditPackage } from '../scripts/audit-package.mjs';
import { SHIPPED_PROMPTS } from '../scripts/package-resources.mjs';
import { root, builder, stage, put, clonePackage } from './fixtures/package-stage.mjs';
const shipped = builder.files.filter(entry => !entry.startsWith('!'));

test('builder includes all desktop requires and explicit resource paths without requiring a lib build', () => {
  for (const entry of shipped.filter(entry => !/[*?]/.test(entry) && !entry.startsWith('lib/')))
    assert.ok(fs.existsSync(path.join(root, entry)), 'Missing declared source resource: ' + entry);
  const desktop = fs.readdirSync(path.join(root, 'desktop')).filter(name => name.endsWith('.cjs'));
  for (const name of desktop) {
    assert.ok(shipped.includes('desktop/' + name), 'Desktop module is not packaged: ' + name);
    const source = fs.readFileSync(path.join(root, 'desktop', name), 'utf8');
    for (const [, request] of source.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
      const resolved = path.posix.normalize(path.posix.join('desktop', request));
      assert.ok(shipped.includes(resolved), 'Missing packaged require: ' + resolved);
      assert.ok(fs.existsSync(path.join(root, resolved)), 'Missing source require: ' + resolved);
    }
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).main, 'desktop/main.cjs');
  assert(shipped.includes('package.json') && shipped.includes('lib/app.js') && shipped.includes('lib/worker.cjs'));
});

test('every source readPrompt/renderPrompt/promptText runtime resource is in the reviewed manifest', () => {
  const required = new Set();
  const queue = ['backend', 'modules', 'prompts', 'shared'];
  while (queue.length) {
    const directory = queue.pop();
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = directory + '/' + entry.name;
      if (entry.isDirectory()) { queue.push(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const [, name] of source.matchAll(/\b(?:readPrompt|renderPrompt|promptText)\(\s*['"]([^'"]+\.(?:md|json))['"]/g)) required.add('prompts/' + name);
    }
  }
  assert(required.size > 20, 'Runtime prompt call-site scan must not silently stop finding resources');
  for (const file of required) assert(SHIPPED_PROMPTS.includes(file), 'Add the runtime template to the reviewed manifest and builder: ' + file);
  // The reviewed catalog also keeps extraction.json for compatibility; not every
  // shipped template must have a current direct call site.
  assert.deepEqual(shipped.filter(file => file.startsWith('prompts/')).sort(), [...SHIPPED_PROMPTS].sort());
  assert(!shipped.includes('prompts/**'));
});

test('build input snapshot requires complete runtime files and native engine bytes', t => {
  const source = stage(t);
  assert.throws(() => capturePackage(source, { ...builder, files: [...builder.files, '!runtime/python/python313.zip'] }), /Missing required runtime input/);
  put(source, 'runtime/wechat39-engine/fixture.dll', 'incorrect synthetic native bytes');
  assert.throws(() => capturePackage(source, builder), /Native engine (?:size|hash) mismatch/);
});

test('post-package audit checks complete real inventory and source-snapshot bytes', t => {
  const source = stage(t), snapshot = capturePackage(source, builder);
  const packaged = clonePackage(t, source, Object.keys(snapshot.files));
  assert.equal(auditPackage(packaged, snapshot).length, Object.keys(snapshot.files).length);
  put(packaged, 'ui/unexpected.js', 'not approved at build start');
  assert.throws(() => auditPackage(packaged, snapshot), /Unexpected packaged file/);
  const changed = clonePackage(t, source, Object.keys(snapshot.files));
  put(changed, 'prompts/identity/default.md', 'valid UTF-8, wrong build');
  assert.throws(() => auditPackage(changed, snapshot), /Packaged bytes differ/);
  const missing = clonePackage(t, source, Object.keys(snapshot.files).filter(file => file !== 'lib/worker.cjs'));
  assert.throws(() => auditPackage(missing, snapshot), /Actual packaged file list/);
});

test('post-package actual files reject unknown prompts and private inputs regardless of builder globs', t => {
  const source = stage(t), snapshot = capturePackage(source, builder);
  for (const file of ['prompts/entries/private.md', 'prompts/identity/' + 'b'.repeat(64) + '.md', 'prompts/reply/unknown.md',
    'prompts/loader.mjs', 'scripts/private-evaluation.mjs', 'artifacts/results.json', 'data/private.json', 'storage/accounts.json',
    'credentials/key.json', 'providers.json', 'runtime/Local State', 'ui/storage/private.json', 'docs/artifacts/private.json',
    'ui/app.js.map', 'lib/testing.js']) {
    const packaged = clonePackage(t, source, Object.keys(snapshot.files));
    put(packaged, file, 'synthetic private input');
    assert.throws(() => auditPackage(packaged, snapshot), /Private|Unknown|Unexpected|Unapproved/);
    assert.equal(fs.readFileSync(path.join(packaged, file), 'utf8'), 'synthetic private input');
  }
});

test('actual package traversal rejects linked asset directories before following them', t => {
  const source = stage(t), snapshot = capturePackage(source, builder);
  const packaged = clonePackage(t, source, Object.keys(snapshot.files));
  fs.symlinkSync(path.join(source, 'ui'), path.join(packaged, 'ui/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => auditPackage(packaged, snapshot), /Linked packaged input/);
});

test('packaged metadata must agree with the version captured before builder starts', t => {
  const source = stage(t), snapshot = capturePackage(source, builder);
  const packaged = clonePackage(t, source, Object.keys(snapshot.files));
  const manifest = JSON.parse(fs.readFileSync(path.join(packaged, 'package.json'), 'utf8'));
  put(packaged, 'package.json', JSON.stringify({ ...manifest, version: '0.0.0-old' }));
  assert.throws(() => auditPackage(packaged, snapshot), /version differs/);
});
