import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const engine = path.join(root, 'runtime/wechat39-engine');
const manifest = JSON.parse(fs.readFileSync(path.join(engine, 'manifest.json'), 'utf8'));
for (const file of manifest.files) {
  if (path.basename(file.name) !== file.name) throw new Error('Invalid native engine manifest');
  const bytes = fs.readFileSync(path.join(engine, file.name));
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Native engine hash mismatch: ' + file.name);
}
if (!fs.existsSync(path.join(root, 'runtime/python/python.exe'))) throw new Error('请先准备完整 Python 运行时：npm run runtime:prepare');
const child = spawn(process.execPath, [path.join(root, 'node_modules/electron-builder/out/cli/cli.js'), '--config', 'electron-builder.json', '--win', ...(process.argv.includes('--dir') ? ['--dir'] : ['nsis']), '--x64'],
  { cwd: root, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  if (code) { process.exitCode = code; return; }
  for (const name of fs.readdirSync(path.join(root, 'release')).filter(name => name.endsWith('-Setup.exe')))
    fs.writeFileSync(path.join(root, 'release', name + '.sha256'), hash(fs.readFileSync(path.join(root, 'release', name))) + '  ' + name + '\n');
  console.log('桌面应用打包完成');
});
