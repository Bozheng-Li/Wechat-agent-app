import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { workTools } from '../lib/testing.js';
import { stickerPng } from './fixtures/stickers.mjs';

test('a queued image task executes its saved parameters once without asking the model to rewrite them', async t => {
  const parent = fs.realpathSync(os.tmpdir()), cwd = fs.mkdtempSync(path.join(parent, 'wechat-app-image-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(cwd)), parent); fs.rmSync(cwd, { recursive: true, force: true }); });
  const request = { prompt: 'A red circle, no text.', path: 'circle.png', providerId: 'test', model: 'image-test', size: '1024x1024' };
  const calls = [], operations = [], png = stickerPng();
  const [tool] = workTools({ cwd, assertAllowed() {}, onOperation: async value => operations.push(value), imageRequest: request,
    imageGeneration: { catalog: () => ({ defaultProviderId: 'test', providers: [{ providerId: 'test', defaultModel: 'image-test', size: request.size }] }),
      generate: async input => { calls.push(input); return { bytes: png, extension: '.png', providerId: 'test', model: 'image-test' }; } } });
  assert.deepEqual(tool.parameters.properties, {}); assert.deepEqual(tool.parameters.required, []);
  const execution = { signal: new AbortController().signal };
  const rejected = JSON.parse(await tool.execute({ prompt: 'A different request' }, execution));
  assert.equal(rejected.ok, false); assert.equal(calls.length, 0);
  const result = JSON.parse(await tool.execute({}, execution));
  assert.equal(result.ok, true); assert.deepEqual(calls, [request]); assert.deepEqual(fs.readFileSync(path.join(cwd, request.path)), png);
  assert.equal(operations.at(-1).path, request.path); assert.equal(result.artifacts.length, 1);
  assert.equal(JSON.parse(await tool.execute({}, execution)).ok, false); assert.equal(calls.length, 1);
});
