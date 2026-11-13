import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = randomUUID();
const env = { ...process.env, WECHAT_APP_TEST_RUN_ID: runId }; delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_HOME;
const child = spawn(require('electron'), [path.join(root, 'tests/desktop-smoke.cjs')], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; console.error('Desktop test timed out; see artifacts/desktop-progress.json'); child.kill(); process.exitCode = 1; }, 180000);
child.once('error', error => { clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  clearTimeout(timeout);
  if (timedOut || signal || code !== 0) { process.exitCode = code || 1; return; }
  try {
    const report = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/desktop-smoke.json'), 'utf8'));
    if (!report.ok || report.runId !== runId) throw new Error('Desktop test exited without a successful report for this run');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});
