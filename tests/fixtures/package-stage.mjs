import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SHIPPED_PROMPTS } from '../../scripts/package-resources.mjs';
import { REQUIRED_RUNTIME_FILES } from '../../scripts/audit-package.mjs';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const builder = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.json'), 'utf8'));
export const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
export function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'wechat-package-test-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    assert.match(path.basename(directory), /^wechat-package-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
export function put(directory, file, bytes) {
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  fs.writeFileSync(path.join(directory, file), bytes);
}
export function stage(t) {
  const directory = temporary(t);
  const wildcardFixtures = { 'ui/**': 'ui/app.js', 'runtime/**': 'runtime/synthetic-runtime.txt', 'docs/**': 'docs/synthetic.md', 'licenses/**': 'licenses/fixture/LICENSE' };
  for (const pattern of builder.files.filter(file => !file.startsWith('!'))) {
    const file = wildcardFixtures[pattern] || pattern;
    put(directory, file, file === 'config.yaml' || SHIPPED_PROMPTS.includes(file)
      ? fs.readFileSync(path.join(root, file)) : '// Synthetic package fixture; no real executable or private data.\n');
  }
  for (const file of REQUIRED_RUNTIME_FILES) put(directory, file, 'Synthetic runtime fixture; not executable.');
  const native = Buffer.from('Synthetic native engine; never executable.');
  put(directory, 'runtime/wechat39-engine/fixture.dll', native);
  put(directory, 'runtime/wechat39-engine/manifest.json', JSON.stringify({ files: [{ name: 'fixture.dll', bytes: native.length,
    sha256: createHash('sha256').update(native).digest('hex') }] }));
  put(directory, 'package.json', JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', main: pkg.main }));
  put(directory, 'electron-builder.json', JSON.stringify(builder));
  return directory;
}
export function clonePackage(t, source, files) {
  const directory = temporary(t);
  for (const file of files) put(directory, file, fs.readFileSync(path.join(source, file)));
  return directory;
}
