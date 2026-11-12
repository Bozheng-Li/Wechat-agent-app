import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--from-plugin')) throw new Error('Pass --from-plugin to explicitly use the plugin API credentials and make billable model requests.');
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(root, 'tests/app-live.cjs'), ...process.argv.slice(2)], {
  cwd: root, env, windowsHide: true, stdio: 'inherit',
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = signal || code === null ? 1 : code; });
