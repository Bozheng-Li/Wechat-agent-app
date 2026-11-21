import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { StateStore } from '../backend/storage/state-store.mjs';

const root = path.resolve(import.meta.dirname, '..');
const selected = process.argv.find(value => value.startsWith('--app-dir='))?.slice(10);
assert(selected, 'Provide --app-dir from the current build-manifest.json');
const packageRoot = fs.realpathSync(path.resolve(selected));
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'dsh-wechat-app');
const { createDesktopApplication } = await import(pathToFileURL(path.join(packageRoot, 'lib/app.js')).href);
const parent = fs.realpathSync(os.tmpdir()), dataHome = fs.mkdtempSync(path.join(parent, 'wechat-package-migration-'));
const intended = fs.realpathSync(dataHome), configFile = path.join(dataHome, 'config.yaml');
const encryption = { isAvailable: () => false };
const report = { runId: randomUUID(), version: pkg.version, appDirectory: packageRoot, data: 'synthetic-only', checks: [] };
let app;
try {
  const legacy = new StateStore(dataHome);
  legacy.configure('legacy-account', { enabled: false, privatePeers: ['legacy-friend'], groups: [], prompt: 'OWNER_SENTINEL' });
  legacy.setPersona({ name: '旧版助手', aliases: ['旧别名'], prompt: 'LEGACY_PERSONA_SENTINEL', personaMode: 'standard' });
  assert.equal(parse(fs.readFileSync(configFile, 'utf8')).personas, undefined, 'fixture must start with the single legacy field');
  app = await createDesktopApplication({ dataHome, encryption });
  const first = await app.call('status'); assert.equal(first.ok, true);
  assert.equal(first.value.startupError, undefined);
  assert.equal(first.value.version, pkg.version);
  assert.equal(first.value.persona.prompt, 'LEGACY_PERSONA_SENTINEL');
  assert.equal(first.value.personas.items.length, 1);
  report.checks.push('packaged reader accepts legacy single-persona config without resetting authorization');
  const created = await app.call('persona.create', { source: 'manual', name: '独立的库标题',
    persona: { name: '仍是助手', aliases: [], prompt: 'SECOND_PERSONA_SENTINEL' } });
  assert.equal(created.ok, true, created.error?.message);
  const selectedState = await app.call('status');
  const selectedId = selectedState.value.personas.activeId;
  assert.equal((await app.call('persona.save', { persona: { name: '仍是助手', aliases: [], prompt: 'EDITED_SENTINEL' } })).ok, true);
  await app.close(); app = null;

  app = await createDesktopApplication({ dataHome, encryption });
  const restarted = await app.call('status');
  assert.equal(restarted.value.startupError, undefined);
  assert.equal(restarted.value.persona.prompt, 'EDITED_SENTINEL');
  assert.equal(restarted.value.personas.activeId, selectedId);
  assert.equal(restarted.value.personas.items.find(item => item.id === selectedId).name, '独立的库标题');
  assert.equal(restarted.value.personas.items.length, 2);
  await app.close(); app = null;
  const reloaded = new StateStore(dataHome);
  assert.deepEqual(reloaded.settings('legacy-account').privatePeers, ['legacy-friend']);
  assert.equal(reloaded.settings('legacy-account').prompt, 'OWNER_SENTINEL');
  report.checks.push('library bodies, distinct titles, selection and original grants survive packaged restart');

  const oldConfig = parse(fs.readFileSync(configFile, 'utf8'));
  oldConfig.personas.push({ id: 'old-distilled', name: '旧模型总结', source: 'distilled', disabled: true,
    persona: { name: '旧助手', aliases: [], prompt: 'OLD_DISTILLED_SENTINEL' } });
  oldConfig.activePersonaId = 'old-distilled';
  fs.writeFileSync(configFile, stringify(oldConfig), 'utf8');
  app = await createDesktopApplication({ dataHome, encryption });
  const oldPersona = await app.call('status');
  assert.equal(oldPersona.value.startupError, undefined);
  assert.equal(oldPersona.value.persona.prompt, 'OLD_DISTILLED_SENTINEL');
  assert.equal(oldPersona.value.personas.activeId, 'old-distilled');
  assert.equal(oldPersona.value.personas.items.find(item => item.id === 'old-distilled').disabled, undefined);
  assert.equal((await app.call('persona.save', { id: 'old-distilled', persona: { name: '旧助手', aliases: [], prompt: 'USER_EDITED_OLD_SUMMARY' } })).ok, true);
  assert.equal((await app.call('persona.create', { source: 'distilled', name: '无令牌总结', persona: { name: '助手', aliases: [], prompt: 'NO_TOKEN_SUMMARY' } })).ok, true);
  await app.close(); app = null;
  const finalStore = new StateStore(dataHome);
  assert.equal(finalStore.persona().prompt, 'NO_TOKEN_SUMMARY');
  assert.equal(finalStore.personaEntries().find(item => item.id === 'old-distilled').persona.prompt, 'USER_EDITED_OLD_SUMMARY');
  assert.deepEqual(finalStore.settings('legacy-account').privatePeers, ['legacy-friend']);
  report.checks.push('legacy distilled/disabled entries stay usable, editable and save offline without a draft token');

  const broken = fs.readFileSync(configFile, 'utf8') + '\nthis_field_does_not_exist: true\n';
  fs.writeFileSync(configFile, broken);
  app = await createDesktopApplication({ dataHome, encryption });
  const invalid = await app.call('status');
  assert.equal(invalid.value.startupError.code, 'CONFIG_INVALID');
  await app.close(); app = null;
  assert.equal(fs.readFileSync(configFile, 'utf8'), broken, 'invalid configuration must remain byte-for-byte recoverable');
  report.checks.push('invalid config is rejected and preserved, never reset');
  report.ok = true;
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts/package-data-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, version: report.version, checks: report.checks }));
} finally {
  await app?.close();
  const resolved = fs.realpathSync(dataHome);
  assert.equal(resolved, intended); assert.equal(path.dirname(resolved), parent);
  assert(path.basename(resolved).startsWith('wechat-package-migration-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
