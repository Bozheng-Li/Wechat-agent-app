import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The installer ships an explicit whitelist of files, so a module the main
// process requires can be missing from the package while every source-level
// test still passes. This guard keeps the whitelist in step with the requires:
// 0.1.7-preview.4 crashed on launch because desktop/blockmap.cjs was never added.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.json'), 'utf8'));
const listed = config.files;
const shipped = listed.filter(entry => !entry.startsWith('!'));

// A whitelist entry without a wildcard must name a real file, or the build
// silently ships less than the author believes.
for (const entry of shipped.filter(entry => !/[*?]/.test(entry)))
  assert.ok(fs.existsSync(path.join(root, entry)), 'electron-builder.json lists a missing file: ' + entry);

// Every desktop module is part of the main process and must be listed.
const desktop = fs.readdirSync(path.join(root, 'desktop')).filter(name => name.endsWith('.cjs'));
for (const name of desktop)
  assert.ok(shipped.includes('desktop/' + name), 'desktop/' + name + ' is not packaged by electron-builder.json');

// Every relative require inside a packaged module must resolve inside the package.
const requires = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
for (const name of desktop) {
  const source = fs.readFileSync(path.join(root, 'desktop', name), 'utf8');
  for (const [, request] of source.matchAll(requires)) {
    const resolved = path.posix.normalize(path.posix.join('desktop', request));
    assert.ok(shipped.includes(resolved), 'desktop/' + name + " requires " + request + ' but ' + resolved + ' is not packaged');
    assert.ok(fs.existsSync(path.join(root, resolved)), 'desktop/' + name + ' requires a missing file: ' + resolved);
  }
}

// The entry point and its package metadata travel together.
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).main, 'desktop/main.cjs');
assert.ok(shipped.includes('package.json') && shipped.includes('desktop/main.cjs'));
