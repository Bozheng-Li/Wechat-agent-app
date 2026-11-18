import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { packageResources, packageFiles, SHIPPED_PROMPTS } from '../scripts/package-resources.mjs';
import { root, builder, stage, put, temporary } from './fixtures/package-stage.mjs';

// No lib/testing.js or build step: execute the real source loader relocated to a
// synthetic code bundle, with its two imports pointing at their source leaves.
test('relocated source loader can read every shipped Markdown and JSON template without source prompt modules', async t => {
  const directory = stage(t);
  let loader = fs.readFileSync(path.join(root, 'prompts/loader.mjs'), 'utf8');
  loader = loader.replace('../backend/platform/resources.mjs', './resources.mjs').replace('../shared/contracts.mjs', './errors.mjs');
  put(directory, 'lib/loader.mjs', loader);
  put(directory, 'lib/resources.mjs', fs.readFileSync(path.join(root, 'backend/platform/resources.mjs')));
  put(directory, 'lib/errors.mjs', fs.readFileSync(path.join(root, 'shared/errors.mjs')));
  const api = await import(pathToFileURL(path.join(directory, 'lib/loader.mjs')).href);
  for (const file of SHIPPED_PROMPTS) {
    const name = file.slice('prompts/'.length), text = fs.readFileSync(path.join(directory, file), 'utf8');
    if (file.endsWith('.md')) assert.equal(api.readPrompt(name), text);
    else for (const [key, value] of Object.entries(JSON.parse(text))) {
      const slots = [...value.matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1]));
      const values = Array.from({ length: Math.max(-1, ...slots) + 1 }, (_, index) => 'fixture-' + index);
      assert.equal(api.promptText(name, key, values), value.replace(/\{\{(\d+)\}\}/g, (_, index) => values[index]));
    }
  }
  assert.equal(parse(fs.readFileSync(path.join(directory, 'config.yaml'), 'utf8')).ownerStoreId, null);
  assert(!fs.existsSync(path.join(directory, 'backend')));
  assert(!fs.existsSync(path.join(directory, 'prompts/loader.mjs')));
  put(directory, 'prompts/conversation/templates.json', 'invalid JSON');
  assert.throws(() => api.promptText('conversation/templates.json', 'anything'), { code: 'PROMPT_INVALID' });
});

test('resource gate uses the real builder whitelist and immutable reviewed manifest', t => {
  const directory = stage(t);
  assert(Object.isFrozen(SHIPPED_PROMPTS));
  assert.deepEqual(packageResources(directory), ['config.yaml', ...SHIPPED_PROMPTS].sort());
  assert.deepEqual(packageResources(directory, builder), ['config.yaml', ...SHIPPED_PROMPTS].sort());
  assert.throws(() => packageResources(directory, { name: 'not-the-builder' }), /whitelist/);
  assert.throws(() => packageResources(directory, { ...builder, files: [...builder.files, 'prompts/**'] }), /wildcard/);
  assert.throws(() => packageResources(directory, { ...builder, files: [...builder.files, { from: 'data', to: 'ui' }] }), /string/);
  assert.throws(() => packageResources(directory, { ...builder, extraResources: ['data'] }), /Unaudited/);
  assert.throws(() => packageResources(directory, { ...builder, files: [...builder.files, '!prompts/reply/defaults.md'] }), /No packaged file/);
});

test('private and unknown prompts remain untouched and cannot be added to the package', t => {
  const directory = stage(t);
  for (const file of ['prompts/entries/personal.md', 'prompts/identity/' + 'a'.repeat(64) + '.md', 'prompts/AGENT.md', 'prompts/reply/unknown.md', 'prompts/loader.mjs']) {
    put(directory, file, 'Synthetic user-owned content, not a template.');
    assert(!packageFiles(directory, builder).includes(file));
    assert.throws(() => packageResources(directory, { ...builder, files: [...builder.files, file] }), /Unknown shipped prompt/);
    assert.equal(fs.readFileSync(path.join(directory, file), 'utf8'), 'Synthetic user-owned content, not a template.');
  }
});

test('private script/artifact/data paths are rejected and exclusions are actually applied', t => {
  const directory = stage(t);
  for (const file of ['scripts/private-evaluation.mjs', 'artifacts/eval.json', 'data/private.json', 'storage/account.json', 'credentials/token.json', 'providers.json', 'Local State', 'docs/scripts/private.mjs']) {
    put(directory, file, 'Synthetic private fixture');
    assert.throws(() => packageResources(directory, { ...builder, files: [...builder.files, file] }), /Private/);
  }
  for (const file of ['ui/app.js.map', 'runtime/__pycache__/sample.pyc', 'runtime/storage/private.json', 'docs/artifacts/private.json']) put(directory, file, 'excluded fixture');
  const files = packageFiles(directory, builder);
  assert(!files.some(file => /private|\.map$|\.pyc$/.test(file)));
  assert.throws(() => packageResources(directory, { ...builder, files: [...builder.files, '**/*'] }), /wildcard/);
});

test('resource validation rejects authorization, credentials, providers, machine paths and malformed templates', t => {
  const directory = stage(t), file = path.join(directory, 'config.yaml'), original = fs.readFileSync(file, 'utf8');
  for (const change of [config => { config.ownerStoreId = 'runtime-owner'; },
    config => { config.accounts = { owner: { enabled: true } }; },
    config => { config.modelConfig.apiKey = 'synthetic-secret'; },
    config => { config.storageSettings.workspacePath = 'C:\\fixture\\workspace'; },
    config => { config.remote.globalAdminIds = ['wxid_fixture_admin']; },
    config => { config.conversationDefaults.remoteEnabled = true; },
    config => { config.conversationDefaults.adminIds = ['wxid_fixture_admin']; },
    config => { config.imageGeneration.providers = [{ id: 'fixture' }]; }]) {
    const config = parse(original); change(config); fs.writeFileSync(file, stringify(config));
    assert.throws(() => packageResources(directory, builder));
  }
  fs.writeFileSync(file, original);
  const prompt = 'prompts/identity/default.md';
  put(directory, prompt, Buffer.from([0xff]));
  assert.throws(() => packageResources(directory, builder), /encoded data/);
  put(directory, prompt, 'Valid fixture');
  put(directory, 'prompts/conversation/templates.json', '{"entry": {"private": true}}');
  assert.throws(() => packageResources(directory, builder), /Invalid prompt catalog/);
});

test('linked resource directories are rejected without following them', t => {
  const directory = stage(t), outside = temporary(t), promptDirectory = path.join(directory, 'prompts/identity');
  fs.renameSync(promptDirectory, path.join(directory, 'saved-identity'));
  put(outside, 'default.md', 'Synthetic external file');
  fs.symlinkSync(outside, promptDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => packageResources(directory, builder), /Linked package input/);
});
