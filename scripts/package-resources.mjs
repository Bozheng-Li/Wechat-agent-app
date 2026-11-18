import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';

// This reviewed, source-controlled manifest is independent of the workspace and
// builder globs. JavaScript in prompts/ is bundled, never shipped as a template.
const manifest = JSON.parse(fs.readFileSync(new URL('./shipped-prompts.json', import.meta.url), 'utf8'));
assert.equal(manifest.schemaVersion, 1, 'Unsupported shipped prompt manifest');
export const SHIPPED_PROMPTS = Object.freeze([...manifest.files]);
assert.equal(new Set(SHIPPED_PROMPTS).size, SHIPPED_PROMPTS.length, 'Duplicate shipped prompt');
assert(SHIPPED_PROMPTS.every(file => /^prompts\/[a-z0-9][a-z0-9/_-]*\.(md|json)$/.test(file)
  && !/(?:^|\/)(?:entries|[a-f0-9]{32,})[/.]/i.test(file)), 'Invalid shipped prompt manifest');
const promptSet = new Set(SHIPPED_PROMPTS);
const CODE = new Set(['package.json', 'desktop/main.cjs', 'desktop/network.cjs', 'desktop/preload.cjs',
  'desktop/updates.cjs', 'desktop/blockmap.cjs', 'desktop/icon.ico', 'lib/app.js', 'lib/worker.cjs',
  'config.yaml', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'README.md']);
const TREES = new Set(['ui', 'runtime', 'docs', 'licenses']);
const PRIVATE = /(?:^|\/)(?:artifacts|storage|credentials(?:\.[^/]*)?|providers(?:\.[^/]*)?|scripts|\.git|\.env(?:\.[^/]*)?|Local State)(?:\/|$)/i;

function normalized(file) {
  assert(typeof file === 'string' && file && !file.includes('\\') && !file.includes('\0')
    && !path.posix.isAbsolute(file) && !path.win32.isAbsolute(file)
    && !file.split('/').some(part => !part || part === '.' || part === '..'), `Invalid package path: ${file}`);
  return file;
}
export function assertPackagePath(file, directory = false) {
  normalized(file);
  assert(!PRIVATE.test(file) && !/^(?:data|tests|node_modules|backend|modules|shared)(?:\/|$)/i.test(file), `Private/development input in package: ${file}`);
  const first = file.split('/')[0];
  if (file === 'prompts' && directory) return;
  if (first === 'prompts') {
    assert(directory ? SHIPPED_PROMPTS.some(item => item.startsWith(file + '/')) : promptSet.has(file), `Unknown shipped prompt: ${file}`);
  } else {
    assert(TREES.has(first) || (directory ? [...CODE].some(item => item.startsWith(file + '/')) : CODE.has(file)), `Unapproved package input: ${file}`);
  }
}
function globPattern(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] !== '*') { source += '[^/]*'; continue; }
      if (pattern[index + 2] === '/') { source += '(?:[^/]+/)*'; index += 2; }
      else { source += '.*'; index += 1; }
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$');
}
function plain(root, relative) {
  for (let current = path.join(root, relative); ; current = path.dirname(current)) {
    assert(!fs.lstatSync(current).isSymbolicLink(), `Linked package input: ${relative}`);
    if (current === root) break;
  }
}
export function packageConfig(root, config) {
  config ??= JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.json'), 'utf8'));
  assert(Array.isArray(config.files) && config.files.length, 'Missing builder package whitelist');
  assert(config.asar === false, 'Actual-file auditing requires asar: false');
  for (const key of ['extraFiles', 'extraResources', 'afterPack', 'afterSign', 'beforePack', 'afterAllArtifactBuild'])
    assert(!config[key], `Unaudited builder option: ${key}`);
  assert(!config.win?.files && !config.win?.extraFiles && !config.win?.extraResources, 'Unaudited Windows file overrides');
  assert(config.files.every(entry => typeof entry === 'string' && entry), 'Only string builder whitelist entries are supported');
  assert.equal(new Set(config.files).size, config.files.length, 'Duplicate package resource');
  const positives = config.files.filter(entry => !entry.startsWith('!'));
  for (const pattern of positives) {
    normalized(pattern);
    if (/[*?]/.test(pattern)) assert(TREES.has(pattern.split('/')[0]) && pattern === pattern.split('/')[0] + '/**', `Unapproved package wildcard: ${pattern}`);
    else assertPackagePath(pattern);
  }
  for (const pattern of config.files.filter(entry => entry.startsWith('!'))) {
    normalized(pattern.slice(1));
    assert(!/[{}()[\]]/.test(pattern), `Unsupported package exclusion: ${pattern}`);
  }
  assert.deepEqual(positives.filter(file => file.startsWith('prompts/')).sort(), [...SHIPPED_PROMPTS].sort(), 'Builder must list every shipped prompt exactly');
  assert(positives.includes('config.yaml') && positives.includes('package.json'), 'Missing package defaults/metadata');
  return config;
}

/** Expand the actual builder whitelist, applying exclusions before reading bytes. */
export function packageFiles(root, config) {
  root = path.resolve(root);
  config = packageConfig(root, config);
  const excludes = config.files.filter(entry => entry.startsWith('!')).map(entry => globPattern(entry.slice(1)));
  const excluded = file => excludes.some(regex => regex.test(file));
  const result = new Set();
  for (const pattern of config.files.filter(entry => !entry.startsWith('!'))) {
    const files = [];
    if (!pattern.endsWith('/**')) {
      if (!excluded(pattern)) { plain(root, pattern); assert(fs.statSync(path.join(root, pattern)).isFile(), `Not a package file: ${pattern}`); files.push(pattern); }
    } else {
      const queue = [pattern.slice(0, -3)];
      while (queue.length) {
        const current = queue.pop();
        plain(root, current);
        for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
          const relative = current + '/' + entry.name;
          if (excluded(relative) || (entry.isDirectory() && excluded(relative + '/'))) continue;
          assertPackagePath(relative, entry.isDirectory());
          assert(!entry.isSymbolicLink(), `Linked package input: ${relative}`);
          if (entry.isDirectory()) queue.push(relative);
          else { assert(entry.isFile(), `Not a package file: ${relative}`); files.push(relative); }
        }
      }
    }
    assert(files.length, `No packaged file matches: ${pattern}`);
    for (const file of files) result.add(file);
  }
  return [...result].sort();
}

/** Only declared defaults/templates enter a package; workspace prompts stay private. */
export function packageResources(root, config) {
  const selected = packageFiles(root, config);
  const files = selected.filter(file => file === 'config.yaml' || file.startsWith('prompts/'));
  assert.deepEqual(files, ['config.yaml', ...SHIPPED_PROMPTS].sort(), 'Missing configuration/prompt defaults');
  for (const file of files) {
    const stat = fs.statSync(path.join(root, file));
    assert(stat.isFile() && stat.size <= 1024 * 1024, `Invalid package resource: ${file}`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.join(root, file)));
    if (file.endsWith('.json')) {
      const catalog = JSON.parse(text);
      assert(catalog && !Array.isArray(catalog) && typeof catalog === 'object' && Object.values(catalog).every(value => typeof value === 'string'), `Invalid prompt catalog: ${file}`);
    }
  }
  const document = parseDocument(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'), { uniqueKeys: true });
  assert.equal(document.errors.length, 0, 'Invalid default YAML');
  const defaults = document.toJS({ maxAliasCount: 20 });
  assert(defaults.version === 1 && defaults.ownerStoreId === null && defaults.connectionWanted === false, 'Package must contain unowned, disconnected defaults');
  for (const key of ['accounts', 'conversationConfigs', 'imageMemory', 'media'])
    assert(defaults[key] && Object.keys(defaults[key]).length === 0, `Workspace configuration in package: ${key}`);
  assert.deepEqual(defaults.remote, { globalAdminIds: [] }, 'Package must not grant global administrator access');
  assert(defaults.conversationDefaults.remoteEnabled === false && Array.isArray(defaults.conversationDefaults.adminIds) && !defaults.conversationDefaults.adminIds.length,
    'Package must keep conversation remote access disabled');
  assert.deepEqual(defaults.imageGeneration, { enabled: false, defaultProviderId: '', providers: [] }, 'Package must not contain configured image providers');
  const privateKey = value => value && typeof value === 'object' && Object.entries(value).some(([key, item]) => /(?:api.?key|password|token|secret|credential)/i.test(key) && key !== 'maxTokens' || privateKey(item));
  assert(!privateKey(defaults), 'Credentials must not enter package defaults');
  for (const value of [defaults.storageSettings.workspacePath, defaults.storageSettings.recordsPath, defaults.prompts.identity])
    assert(typeof value === 'string' && value && !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.split(/[\\/]/).includes('..'), 'Package defaults must use relative workspace paths');
  return files;
}
