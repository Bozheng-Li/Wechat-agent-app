import fs from 'node:fs';
import path from 'node:path';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { workPath } from '../work/policy.mjs';
import { readWorkArtifact } from '../work/artifacts.mjs';
import { workImageRequest } from '../../shared/work-image-request.mjs';

/** App tasks expose image generation only. Arbitrary shell/filesystem tools are absent. */
export function workTools({ cwd, assertAllowed, onOperation = async () => {}, imageGeneration, imageRequest }) {
  if (!imageGeneration) return [];
  const selected = imageRequest === undefined ? undefined : workImageRequest(imageRequest);
  const attempts = new Set(); let attemptedSelected = false;
  const catalog = imageGeneration.catalog();
  return [{ name: 'wechat_work_generate_image', description: '调用已配置的生图 API，保存到本任务目录，任务完成后回传图片。工具返回成功前不可声称已生成。\n' +
      (selected ? '本任务已保存完整生图参数，调用时传空对象 {}，后端会原样使用这些参数，不重新改写提示词或选择模型：' + JSON.stringify(selected)
        : '已指定接口或模型时严格使用指定值。\n可用接口：' + JSON.stringify(catalog)),
    parameters: { type: 'object', properties: selected ? {} : { prompt: { type: 'string' }, path: { type: 'string' }, providerId: { type: 'string' }, model: { type: 'string' }, size: { type: 'string' } }, required: selected ? [] : ['prompt', 'path'], additionalProperties: false },
    execute: async (args, execution) => {
      assertAllowed(); execution.signal.throwIfAborted(); let result;
      try {
        if (selected && Object.entries(selected).some(([key, value]) => args[key] !== undefined && args[key] !== value))
          throw new ChannelError('WORK_IMAGE_REQUEST_CHANGED', '本任务已指定生图参数，请使用原参数');
        const query = selected ?? args;
        if (typeof query.path !== 'string' || !/\.(png|jpe?g)$/i.test(query.path)) throw new ChannelError('WORK_PATH_INVALID', '图片文件名应以 .png 或 .jpg 结尾');
        const target = workPath(cwd, query.path);
        if (fs.existsSync(target)) throw new ChannelError('WORK_FILE_CHANGED', '目标图片已存在，请使用新的文件名');
        const provider = catalog.providers.find(value => value.providerId === (query.providerId ?? catalog.defaultProviderId));
        const fingerprint = JSON.stringify([query.prompt, query.providerId ?? catalog.defaultProviderId, query.model ?? provider?.defaultModel, query.size ?? provider?.size]);
        if (attempts.has(fingerprint) || selected && attemptedSelected) throw new ChannelError('WORK_IMAGE_ALREADY_ATTEMPTED', '本任务已尝试过这次生图请求，未重复调用接口');
        attempts.add(fingerprint); if (selected) attemptedSelected = true;
        const image = await imageGeneration.generate(query, execution.signal, assertAllowed);
        assertAllowed(); execution.signal.throwIfAborted();
        const relative = query.path.slice(0, -path.extname(query.path).length) + image.extension;
        const destination = workPath(cwd, relative);
        if (fs.existsSync(destination)) throw new ChannelError('WORK_FILE_CHANGED', '目标图片已存在，未覆盖');
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); atomicBytes(destination, image.bytes);
        const { metadata } = readWorkArtifact(cwd, relative, undefined, image.sendAs ?? 'auto');
        result = { ok: true, artifacts: [metadata], providerId: image.providerId, providerName: image.providerName, model: image.model,
          prompt: query.prompt.slice(0, 4000), message: '图片已生成并保存，任务完成后回传微信；此时尚未发送。' };
      } catch (error) {
        execution.signal.throwIfAborted(); result = { ok: false, ...publicError(error, '生图操作失败'), automaticRetry: false,
          ...(error.imageGeneration ? { imageGeneration: error.imageGeneration } : {}) };
      }
      await onOperation({ tool: 'wechat_work_generate_image', path: selected?.path ?? args.path, result });
      assertAllowed(); execution.signal.throwIfAborted(); return JSON.stringify(result);
    },
  }];
}
