import { ChannelError, publicError } from '../../shared/contracts.mjs';

/**
 * Chat-side image generation. The generated picture joins the reply that is
 * already being composed, so a normal conversation can answer "画一张…" the
 * same way the removed work mode did.
 */
export function imageGenerationTool({ imageGeneration, library, scope, select, assertAllowed = () => {} }) {
  return {
    name: 'wechat_generate_image',
    description:
      '按用户要求生成一张新图片，随本轮回复一起发给对方。用户明确要画图、要一张图、要封面或配图、要改风格重新画时调用。' +
      '只需要写画面描述；不要编造图片地址，也不要先去素材库找图。图片生成成功后会随本轮回复发出，' +
      '返回 ok 后不要重复调用，也不要声称已经发送成功；失败时如实说明这次没有生成。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', maxLength: 4000, description: '画面描述：主体、场景、风格、构图、光线、文字。不要写“生成图片”这类指令。' },
        size: { type: 'string', maxLength: 32, description: '可选尺寸，例如 1024x1024。不确定就不传，使用默认尺寸。' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    execute: async (args, exec) => {
      assertAllowed();
      exec.signal?.throwIfAborted();
      let result;
      try {
        if (
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Object.keys(args).some((key) => key !== 'prompt' && key !== 'size') ||
          typeof args.prompt !== 'string' ||
          !args.prompt.trim() ||
          (args.size !== undefined && typeof args.size !== 'string')
        )
          throw new ChannelError('IMAGE_GENERATION_PROMPT', '请提供要画的内容，最多 4000 字');
        const generated = await imageGeneration.generate(
          { prompt: args.prompt, ...(args.size ? { size: args.size } : {}) },
          exec.signal,
          assertAllowed
        );
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const extension = generated.mediaType === 'image/jpeg' ? 'jpg' : 'png';
        const imported = library.import(scope.accountId, {
          name: `AI-${stamp}.${extension}`,
          kind: 'image',
          data: generated.bytes.toString('base64'),
        });
        const assetId = imported.assetIds?.[0] ?? imported.duplicateIds?.[0];
        if (!assetId) throw new ChannelError('IMAGE_GENERATION_SAVE', '图片已生成，但没有存入素材库，未发出');
        const asset = library.resolveAsset(scope.accountId, assetId);
        select({ asset, caption: '' });
        assertAllowed();
        result = {
          ok: true,
          provider: generated.providerName,
          model: generated.model,
          note: '图片已生成，随本轮回复发出；不要再次调用，也不要声称已经发送成功',
        };
      } catch (error) {
        exec.signal?.throwIfAborted();
        assertAllowed();
        result = { ok: false, ...publicError(error, '这次没有生成图片，未发出') };
      }
      return JSON.stringify(result);
    },
  };
}
