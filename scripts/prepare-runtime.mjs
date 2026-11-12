import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'runtime/python'), cache = path.join(root, 'storage/cache');
const run = (command, args) => { const result = spawnSync(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' }); if (result.status !== 0) throw new Error('运行环境准备失败：' + path.basename(command)); };
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('运行组件需要 Windows x64');
if (!fs.existsSync(path.join(target, 'python.exe'))) {
  fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(target, { recursive: true });
  const archive = path.join(cache, 'python-3.13.9-embed-amd64.zip');
  if (!fs.existsSync(archive)) {
    const response = await fetch('https://www.python.org/ftp/python/3.13.9/python-3.13.9-embed-amd64.zip', { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Python 下载失败：HTTP ' + response.status);
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== '91d828c2da3a029b41699e918674a0cb379c02cf20dab9c501306885f837402a') throw new Error('Python 下载校验失败');
  const quote = text => "'" + text.replaceAll("'", "''") + "'";
  run('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath ' + quote(archive) + ' -DestinationPath ' + quote(target) + ' -Force']);
}
fs.writeFileSync(path.join(target, 'python313._pth'), 'python313.zip\n.\n..\nLib/site-packages\nimport site\n');
run('python', ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', '--only-binary=:all:', '--target', path.join(target, 'Lib/site-packages'),
  '--python-version', '3.13', '--platform', 'win_amd64', '--implementation', 'cp', '--abi', 'cp313', '-r', path.join(root, 'runtime/requirements.txt')]);
run(path.join(target, 'python.exe'), ['-B', '-c', 'import cryptography,PIL,frida; assert cryptography.__version__=="50.0.0"; assert PIL.__version__=="12.3.0"; assert frida.__version__=="17.24.3"; print("Python runtime verified")']);
