import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { artifactName, createBuildOutput, verifyArtifacts, attachBuildManifest, publishArtifacts } from '../scripts/package.mjs';
import { temporary, put } from './fixtures/package-stage.mjs';
const pkg = { name: 'dsh-wechat-app', version: '1.2.3-fixture' };
const builder = { win: { artifactName: 'Fixture-${version}-Setup.${ext}' } };
const installer = Buffer.from('SYNTHETIC TEST BYTES; not an executable');
const blockmap = Buffer.from('SYNTHETIC BLOCKMAP; not an actual installer artifact');
const digest = createHash('sha512').update(installer).digest('base64');
const name = artifactName(builder, pkg);
function artifacts(directory, change = value => value) {
  put(directory, name, installer); put(directory, name + '.blockmap', blockmap);
  const feed = change({ version: pkg.version, files: [{ url: name, sha512: digest, size: installer.length, blockMapSize: blockmap.length }], path: name, sha512: digest });
  put(directory, 'latest.yml', stringify(feed));
}

test('importing packaging helpers never starts a builder; fresh output cannot reuse a previous successful build', t => {
  const parent = temporary(t), old = path.join(parent, 'old-release');
  artifacts(old);
  const output = createBuildOutput(parent), second = createBuildOutput(parent);
  assert.notEqual(output, second);
  assert.deepEqual(fs.readdirSync(output), []);
  assert.throws(() => verifyArtifacts(output, builder, pkg), /ENOENT/);
  assert(fs.existsSync(path.join(old, 'latest.yml')));
  assert(!fs.existsSync(path.join(old, name + '.sha256')));
});

test('same-build feed/version/size/hash and sidecar are derived from the verified bytes', t => {
  const output = temporary(t), release = temporary(t);
  artifacts(output);
  const verified = verifyArtifacts(output, builder, pkg);
  // A concurrent replacement after verification cannot change published bytes.
  put(output, name, 'changed after verification');
  publishArtifacts(verified, release);
  assert.deepEqual(fs.readFileSync(path.join(release, name)), installer);
  assert.equal(fs.readFileSync(path.join(release, name + '.sha256'), 'utf8'), createHash('sha256').update(installer).digest('hex') + '  ' + name + '\n');
  assert.equal(verifyArtifacts(release, builder, pkg).name, name);
});

test('stale or mixed installer metadata fails without creating any hash sidecar', t => {
  for (const change of [feed => ({ ...feed, version: 'old-version' }), feed => ({ ...feed, path: 'old.exe' }),
    feed => ({ ...feed, sha512: 'old-hash' }), feed => ({ ...feed, files: [] }),
    feed => ({ ...feed, files: [...feed.files, feed.files[0]] }),
    feed => ({ ...feed, files: [{ ...feed.files[0], url: 'other.exe' }] }),
    feed => ({ ...feed, files: [{ ...feed.files[0], size: 1 }] }),
    feed => ({ ...feed, files: [{ ...feed.files[0], sha512: 'old-hash' }] }),
    feed => ({ ...feed, files: [{ ...feed.files[0], blockMapSize: 1 }] })]) {
    const output = temporary(t); artifacts(output, change);
    assert.throws(() => verifyArtifacts(output, builder, pkg), /latest.yml/);
    assert(!fs.existsSync(path.join(output, name + '.sha256')));
  }
});

test('published build report records the exact app directory, input snapshot and artifact hashes', t => {
  const output = temporary(t), release = temporary(t); artifacts(output);
  const snapshot = { version: pkg.version, files: { 'lib/app.js': 'synthetic-input-sha256' } };
  const verified = attachBuildManifest(verifyArtifacts(output, builder, pkg), { output, snapshot });
  assert.equal([...verified.files.keys()].at(-1), 'latest.yml');
  publishArtifacts(verified, release);
  const report = JSON.parse(fs.readFileSync(path.join(release, 'build-manifest.json'), 'utf8'));
  assert.equal(report.appDirectory, path.resolve(output, 'win-unpacked/resources/app'));
  assert.equal(report.version, pkg.version);
  assert.deepEqual(report.packagedFiles, snapshot.files);
  assert(report.outputIsTemporary);
  assert.equal(report.artifacts.find(item => item.file === name).sha256, createHash('sha256').update(installer).digest('hex'));
  // A later report can replace metadata without rewriting immutable installer bytes.
  publishArtifacts(attachBuildManifest(verifyArtifacts(output, builder, pkg), { output, snapshot }), release);
});

test('conflicting same-version builds leave existing published installer and feed unchanged', t => {
  const output = temporary(t), release = temporary(t); artifacts(output);
  const verified = verifyArtifacts(output, builder, pkg);
  put(release, name, 'previous build of the same version');
  put(release, 'latest.yml', 'previous feed, never replace on failure');
  assert.throws(() => publishArtifacts(verified, release), /Refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(release, name), 'utf8'), 'previous build of the same version');
  assert.equal(fs.readFileSync(path.join(release, 'latest.yml'), 'utf8'), 'previous feed, never replace on failure');
  assert(!fs.existsSync(path.join(release, name + '.sha256')));
  assert(!fs.existsSync(path.join(release, '.package-publish.lock')));
});

test('a held publisher lock rejects a concurrent run without modifying existing files', t => {
  const output = temporary(t), release = temporary(t); artifacts(output);
  put(release, '.package-publish.lock', 'synthetic other publisher');
  assert.throws(() => publishArtifacts(verifyArtifacts(output, builder, pkg), release), /EEXIST/);
  assert.deepEqual(fs.readdirSync(release), ['.package-publish.lock']);
});

test('missing blockmap/feed and unresolved or escaping artifact names are rejected', t => {
  const output = temporary(t); put(output, name, installer);
  assert.throws(() => verifyArtifacts(output, builder, pkg), /ENOENT/);
  put(output, name + '.blockmap', blockmap);
  assert.throws(() => verifyArtifacts(output, builder, pkg), /ENOENT/);
  for (const pattern of ['../outside.exe', 'C:\\outside.exe', '${unknown}.exe'])
    assert.throws(() => artifactName({ win: { artifactName: pattern } }, pkg), /Invalid installer/);
});
