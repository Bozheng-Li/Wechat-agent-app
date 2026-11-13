import assert from 'node:assert/strict';
import test from 'node:test';
import { imageGenerationTool } from '../modules/tools/image-generation.mjs';

const signal = new AbortController().signal;

function fixture({ generate } = {}) {
  const selected = [], imports = [], calls = [];
  const service = {
    generate: async (request, received, check) => {
      calls.push({ request, received });
      check?.();
      if (generate) return generate(request, received);
      return { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]), mediaType: 'image/png', extension: '.png',
        providerId: 'haina', providerName: '海纳', model: 'gpt-image-2', sendAs: 'image' };
    },
  };
  const library = {
    import: (accountId, input) => { imports.push({ accountId, input }); return { imported: 1, duplicates: 0, assetIds: ['asset-1'], duplicateIds: [], total: 1 }; },
    resolveAsset: (accountId, assetId) => ({ id: assetId, name: 'AI.png', kind: 'image', description: '', usage: '' }),
  };
  const tool = imageGenerationTool({ imageGeneration: service, library, scope: { accountId: 'wxid_owner' },
    select: value => selected.push(value), assertAllowed: () => {} });
  return { tool, selected, imports, calls };
}

test('聊天里可以直接生图，生成的图片随本轮回复一起发出', async () => {
  const f = fixture();
  const result = JSON.parse(await f.tool.execute({ prompt: '一只在窗台上晒太阳的橘猫', size: '1024x1024' }, { signal }));
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-image-2');
  assert.deepEqual(f.calls[0].request, { prompt: '一只在窗台上晒太阳的橘猫', size: '1024x1024' });
  assert.equal(f.imports.length, 1);
  assert.equal(f.imports[0].accountId, 'wxid_owner');
  assert.equal(f.imports[0].input.kind, 'image');
  assert.match(f.imports[0].input.name, /^AI-.*\.png$/);
  assert.equal(f.imports[0].input.data, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]).toString('base64'));
  assert.equal(f.selected.length, 1);
  assert.equal(f.selected[0].asset.id, 'asset-1');
  assert.equal(f.selected[0].caption, '');
});

test('重复生成同一张图时复用已有素材，不会因为没有新增而丢掉图片', async () => {
  const f = fixture();
  f.tool = imageGenerationTool({ imageGeneration: { generate: async () => ({ bytes: Buffer.from([1, 2, 3]), mediaType: 'image/png', providerName: '接口', model: 'm' }) },
    library: { import: () => ({ imported: 0, duplicates: 1, assetIds: [], duplicateIds: ['asset-dup'] }),
      resolveAsset: (accountId, assetId) => ({ id: assetId, name: 'dup.png', kind: 'image', description: '', usage: '' }) },
    scope: { accountId: 'wxid_owner' }, select: value => f.selected.push(value), assertAllowed: () => {} });
  const result = JSON.parse(await f.tool.execute({ prompt: '同一张图' }, { signal }));
  assert.equal(result.ok, true);
  assert.equal(f.selected[0].asset.id, 'asset-dup');
});

test('生图失败时如实返回错误，不选择图片也不声称已经发出', async () => {
  const f = fixture({ generate: () => { throw Object.assign(new Error('上游拒绝'), { code: 'IMAGE_GENERATION_HTTP' }); } });
  const result = JSON.parse(await f.tool.execute({ prompt: '画一张图' }, { signal }));
  assert.equal(result.ok, false);
  assert.equal(f.selected.length, 0);
  assert.equal(f.imports.length, 0);
});

test('没有提示词就不调用生图接口', async () => {
  const f = fixture();
  const result = JSON.parse(await f.tool.execute({ prompt: '   ' }, { signal }));
  assert.equal(result.ok, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.selected.length, 0);
});
