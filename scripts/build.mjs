import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const alias = { '@napcat-wechat/protocol': path.join(root, 'backend/wechat/types.ts') };
const packages = new Set();
fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
fs.mkdirSync(path.join(root, 'ui'), { recursive: true });
// The license tree is generated output: it is rebuilt from scratch so a removed
// dependency cannot keep a stale license file in the package.
fs.rmSync(path.join(root, 'licenses'), { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'licenses'), { recursive: true });
async function bundle(input, output, platform, format) {
  const build = await rolldown({ input: path.join(root, input), platform, resolve: { alias } });
  try {
    const result = await build.write({ file: path.join(root, output), format, sourcemap: true });
    for (const chunk of result.output) if (chunk.type === 'chunk') for (const name of chunk.moduleIds) {
      const normalized = name.replaceAll('\\', '/'), marker = normalized.lastIndexOf('/node_modules/');
      if (marker < 0) continue;
      const parts = normalized.slice(marker + 14).split('/');
      packages.add(parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/'));
    }
  } finally { await build.close(); }
}
await bundle('backend/index.mjs', 'lib/app.js', 'node', 'esm');
await bundle('backend/worker.mjs', 'lib/worker.cjs', 'node', 'cjs');
await bundle('tests/exports.mjs', 'lib/testing.js', 'node', 'esm');
await bundle('frontend/app.jsx', 'ui/app.js', 'browser', 'iife');
const missing = [];
for (const name of packages) {
  const directory = path.join(root, name === '@nodable/entities' ? 'third-party/nodable-entities' : 'node_modules/' + name);
  const licenses = fs.readdirSync(directory).filter(name => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name));
  // Shipping without a license is a compliance failure, so the build stops and
  // names every package that is missing one instead of the first one found.
  if (!licenses.length) { missing.push(name); continue; }
  for (const file of licenses) {
    const target = path.join(root, 'licenses', name.replaceAll('/', '__'), file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(directory, file), target);
  }
}
if (missing.length) throw new Error('Missing dependency license: ' + missing.join(', '));
fs.writeFileSync(path.join(root, 'ui/index.html'), '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob: https:; font-src \'self\' data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>微信 Agent</title><style>html,body,#root{margin:0;min-height:100%;}body{background:#f5f6f5;}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="app.js" defer></script></body></html>');
console.log('独立 App 已构建：lib/app.js、lib/worker.cjs、ui/app.js');
