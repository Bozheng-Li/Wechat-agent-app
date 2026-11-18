import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { capturePackage, auditPackage } from './audit-package.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha512 = bytes => createHash('sha512').update(bytes).digest('base64');

export function artifactName(config, pkg) {
  const values = { version: pkg.version, ext: 'exe', arch: 'x64', os: 'win', name: pkg.name, productName: config.productName || pkg.productName || pkg.name };
  const name = String(config.win?.artifactName || config.artifactName || '${productName}-${version}-${arch}.${ext}')
    .replace(/\$\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
  assert(name.endsWith('.exe') && !/[\\/:\0]/.test(name) && !name.includes('${') && name !== '..', 'Invalid installer artifact name');
  return name;
}
function baseName(address) {
  const raw = String(address || '').split(/[?#]/)[0];
  try { return path.posix.basename(decodeURIComponent(raw)); } catch { throw new Error('Invalid installer URL'); }
}

/** A fresh output directory is mandatory: timestamps cannot prove build identity. */
export function createBuildOutput(parent = os.tmpdir()) {
  return fs.mkdtempSync(path.join(path.resolve(parent), 'wechat-package-'));
}
export function verifyArtifacts(output, config, pkg) {
  const name = artifactName(config, pkg);
  const read = file => {
    const target = path.join(output, file), stat = fs.lstatSync(target);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, 'Invalid build artifact: ' + file);
    return fs.readFileSync(target);
  };
  const installer = read(name), blockmap = read(name + '.blockmap'), feedBytes = read('latest.yml');
  const digest = sha512(installer), feed = parse(feedBytes.toString('utf8')) || {};
  assert.equal(String(feed.version), pkg.version, 'latest.yml version differs from this build');
  assert(Array.isArray(feed.files) && feed.files.length === 1, 'latest.yml must list only this build installer');
  const listed = feed.files[0];
  assert.equal(baseName(listed?.url), name, 'latest.yml installer differs from this build');
  assert.equal(listed.size, installer.length, 'latest.yml installer size mismatch');
  assert.equal(listed.sha512, digest, 'latest.yml installer sha512 mismatch');
  if (feed.path !== undefined) assert.equal(baseName(feed.path), name, 'latest.yml path differs from this build');
  if (feed.sha512 !== undefined) assert.equal(feed.sha512, digest, 'latest.yml top-level sha512 mismatch');
  if (feed.size !== undefined) assert.equal(feed.size, installer.length, 'latest.yml top-level size mismatch');
  if (listed.blockMapSize !== undefined) assert.equal(listed.blockMapSize, blockmap.length, 'latest.yml blockmap size mismatch');
  // Keep the verified bytes, not paths that can later be replaced by another run.
  return { name, files: new Map([[name, installer], [name + '.blockmap', blockmap],
    [name + '.sha256', Buffer.from(hash(installer) + '  ' + name + '\n')], ['latest.yml', feedBytes]]) };
}
export function attachBuildManifest(artifacts, { output, snapshot }) {
  const report = { schemaVersion: 1, version: snapshot.version, createdAt: new Date().toISOString(),
    outputDirectory: path.resolve(output), appDirectory: path.resolve(output, 'win-unpacked/resources/app'),
    outputIsTemporary: true, packagedFileCount: Object.keys(snapshot.files).length,
    packagedFiles: snapshot.files,
    artifacts: [...artifacts.files].map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: hash(bytes) })) };
  const feed = artifacts.files.get('latest.yml');
  artifacts.files.delete('latest.yml');
  artifacts.files.set('build-manifest.json', Buffer.from(JSON.stringify(report, null, 2) + '\n'));
  artifacts.files.set('latest.yml', feed);
  return artifacts;
}
export function publishArtifacts(artifacts, destination) {
  destination = path.resolve(destination);
  fs.mkdirSync(destination, { recursive: true });
  assert(!fs.lstatSync(destination).isSymbolicLink(), 'Linked release directory');
  const lock = path.join(destination, '.package-publish.lock');
  const fd = fs.openSync(lock, 'wx'); // Never interleave two publishers.
  try {
    // Versioned artifacts are immutable. A failed re-build of the same version
    // must not replace bytes still referenced by the existing latest.yml.
    for (const [name, bytes] of artifacts.files) {
      assert(path.basename(name) === name && !/[\\/:\0]/.test(name), 'Invalid published artifact name');
      const target = path.join(destination, name);
      if (!fs.existsSync(target)) continue;
      assert(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink(), 'Invalid existing release artifact: ' + name);
      if (!['latest.yml', 'build-manifest.json'].includes(name)) assert(fs.readFileSync(target).equals(bytes), 'Refusing to overwrite different artifact of the same version: ' + name);
    }
    assert.equal([...artifacts.files.keys()].at(-1), 'latest.yml', 'Publish feed last');
    for (const [name, bytes] of artifacts.files) {
      const target = path.join(destination, name);
      if (!['latest.yml', 'build-manifest.json'].includes(name) && fs.existsSync(target)) continue;
      const temporary = path.join(destination, '.' + name + '.' + randomUUID() + '.tmp');
      fs.writeFileSync(temporary, bytes, { flag: 'wx' });
      fs.renameSync(temporary, target);
    }
  } finally {
    fs.closeSync(fd);
    // Only remove the lock this invocation created at its verified fixed path.
    assert.equal(path.dirname(lock), destination);
    fs.unlinkSync(lock);
  }
}

export async function packageApp({ directory = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const builder = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.json'), 'utf8'));
  const snapshot = capturePackage(root, builder);
  // capturePackage also verifies required Python/native runtime files and the
  // native engine's declared sizes/hashes before any builder process starts.
  const output = createBuildOutput();
  console.log('本次独立打包输出：' + output);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/electron-builder/out/cli/cli.js'), '--config', 'electron-builder.json',
      '--config.directories.output=' + output, '--win', ...(directory ? ['--dir'] : ['nsis']), '--x64'],
    { cwd: root, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error(`electron-builder failed (${code ?? signal})`)));
  });
  const app = path.join(output, 'win-unpacked/resources/app');
  const files = auditPackage(app, snapshot);
  console.log(`包后真实清单审计通过：${files.length} 个文件`);
  if (directory) {
    console.log('目录模式打包完成（未生成安装包）：' + path.join(output, 'win-unpacked'));
    return output;
  }
  const artifacts = attachBuildManifest(verifyArtifacts(output, builder, pkg), { output, snapshot });
  const destination = path.resolve(root, builder.directories?.output || 'release');
  publishArtifacts(artifacts, destination);
  console.log('桌面应用打包完成：' + path.join(destination, artifacts.name));
  console.log('构建审计报告：' + path.join(destination, 'build-manifest.json'));
  console.log('启动/迁移验收目录（临时保留，不作为产品交付）：' + app);
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageApp({ directory: process.argv.includes('--dir') }).catch(error => {
    console.error('打包门禁失败：' + (error?.message || error)); process.exitCode = 1;
  });
}
