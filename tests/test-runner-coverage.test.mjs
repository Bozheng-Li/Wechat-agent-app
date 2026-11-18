import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `scripts/test.mjs` runs an explicit list, so a new suite is invisible to
// `npm test` until someone remembers to add it — 64 of the 132 suites were in
// that state, including regressions that would have caught shipping bugs. This
// guard pins the current gap: adding a suite now either wires it in or is
// rejected, and shrinking the list requires deliberately editing this file.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNWIRED = [
  'agent-settings', 'agent-task-boundaries', 'agent-workspace', 'dsh-plugin', 'empty-response-recovery', 'execution-traces-instrument',
  'factual-search-policy', 'identity-persona', 'ignored-references', 'image-generation-providers',
  'image-generation-response', 'image-session', 'live-model-audit-settings', 'long-term-memory',
  'media-conversion', 'memory-behavior-audit', 'memory-compaction-reliability', 'memory-integrity',
  'memory-quality', 'memory-tool-combined', 'model-capability-settings', 'model-info',
  'model-output-tokens', 'model-reasoning-runner', 'model-reasoning-selection', 'module-acceptance',
  'moments-interactions-rpc', 'moments-like-requests', 'moments-likes-rpc', 'moments-protocol',
  'on-demand-image-understanding', 'persona-delivery', 'persona-memory-tasks',
  'persona-migrations', 'plugin-service', 'progressive-context', 'progressive-retrieval-v12',
  'prompt-admin-notes-live-cases', 'prompt-composition', 'remote-administrators',
  'remote-task-status', 'reply-modes', 'reply-review-final', 'reply-review-regressions',
  'request-context', 'request-metrics-isolation', 'runtime-startup', 'runtime-workspace',
  'source-structure', 'specialized-prompts', 'vision-routing', 'wechat-emoji-vision',
  'workbench-deletion', 'workbench-store-compatibility', 'workbench',
];

function suiteNames() {
  return fs.readdirSync(path.join(root, 'tests'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => entry.name.slice(0, -'.test.mjs'.length))
    .sort();
}

// Only the `business` literal decides the run; other quoted strings in the
// runner are module ids and spawn options.
function wiredSuites() {
  const runner = fs.readFileSync(path.join(root, 'scripts/test.mjs'), 'utf8');
  const literal = runner.match(/const business = \[([\s\S]*?)\];/)?.[1];
  assert.ok(literal, 'scripts/test.mjs must keep a `const business = [...]` run list');
  return [...new Set([
    ...[...literal.matchAll(/'([a-z0-9][a-z0-9-]*)'/g)].map((match) => match[1]),
    ...suiteNames().filter(name => name.startsWith('app-')),
  ])];
}

test('every test suite is either run by npm test or pinned as unwired', () => {
  const wired = new Set(wiredSuites());
  const suites = suiteNames();
  assert.ok(suites.length > 100, 'The test directory must still contain the suites this guard measures');
  const unwired = suites.filter((name) => !wired.has(name));
  assert.deepEqual(
    unwired,
    [...UNWIRED].sort(),
    'A suite is neither wired into scripts/test.mjs nor listed as a known gap. Wire it in, or add it to UNWIRED with a reason.'
  );
  for (const name of UNWIRED)
    assert.ok(suites.includes(name), `Stale entry in UNWIRED: ${name} no longer exists — remove it`);
});

test('the runner whitelist still names only suites that exist', () => {
  const suites = new Set(suiteNames());
  const missing = wiredSuites().filter((name) => !suites.has(name));
  assert.deepEqual(missing, [], 'scripts/test.mjs lists a suite that does not exist on disk');
});
