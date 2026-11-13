import { runLocalAgent } from "./local-loop.mjs";
import { promptText } from "../../prompts/loader.mjs";
import { ChannelError } from "../../shared/contracts.mjs";
import { availableModel, visionSelection } from "./models.mjs";
import { webSearchTool } from "../tasks/conversation-tools.mjs";
import { REPLY_STYLE_REVIEW_NOTE, needsConversationalRewrite } from "./reply-style.mjs";
import { SearchService } from "../search/service.mjs";
import { memoryCompressionPrompt } from "../../shared/memory-policy.mjs";
import {
  INTERNAL_OUTPUT_MODES,
  buildWechatPrompt,
  messageWithHistory,
  memoryContext,
  identityData,
  scheduledData,
  imageQualityContext,
  applyFixedReplyBoundaries,
} from "../../prompts/reply/compose.mjs";
import { completedText, retryableEmptyResponse } from "./output.mjs";
import { emptyResponseRetryNote } from '../../prompts/reply/delivery.mjs';
import { reviewMemoryDraft } from '../memory/roles/reflection.mjs';
import { stickerDescriptions } from '../media/description.mjs';
import { TIME_DEFAULTS } from '../../shared/time-settings.mjs';

export class AppAgentRunner {
  constructor(ctx, getModelChoice = () => null, getRuntimeSettings = () => ({})) {
    this.ctx = ctx;
    this.getModelChoice = getModelChoice;
    this.getRuntimeSettings = getRuntimeSettings;
    this.lastSearch = null;
    this.search = new SearchService(ctx, { getAttemptTimeoutMs: () => (this.getRuntimeSettings()?.timeSettings?.searchTimeoutSeconds ?? TIME_DEFAULTS.searchTimeoutSeconds) * 1000 });
  }
  searchStatus() {
    return this.lastSearch ? { ...this.lastSearch } : null;
  }
  searchTool(config = {}, options) {
    const settings = structuredClone(config);
    return webSearchTool(() => this.search.forConfig(settings, options), result => {
      this.lastSearch = { ...result, provider: Object.hasOwn(result, 'provider') ? result.provider : settings.searchProvider ?? 'tavily' };
    }, options);
  }
  defaultSelection() {
    const selection = this.ctx.agentDefaultModel.currentSelection();
    if (!selection?.provider || !selection?.model)
      throw new ChannelError('MODEL_MISSING', '请先在模型设置中添加 API 服务和模型');
    return selection;
  }
  selection() {
    return this.getModelChoice() ?? this.defaultSelection();
  }
  extractLongTermMemory(request) {
    return this.run(request);
  }
  extractRoleCard(request) {
    // run() creates an independent local agent run when no sessionId is set.
    return this.run({ ...request, sessionId: undefined, mode: 'role-memory', tools: [] });
  }
  reviewMemoryReply(input, draft, options) {
    return reviewMemoryDraft(this, input, draft, options);
  }
  async polishReply(reply, request, signal, persona, context = {}) {
    signal.throwIfAborted();
    const runtime = context.runtime ?? structuredClone(this.getRuntimeSettings() ?? {});
    const style = { persona: persona ?? runtime.persona, prompt: context.prompt, identityMarkdown: runtime.identityMarkdown };
    // Style review stays read-only. Complete the owner's exact fixed lines
    // without rewriting the body or requesting another model response.
    if (needsConversationalRewrite(reply, request, style)) context.onStyleWarning?.(REPLY_STYLE_REVIEW_NOTE);
    return applyFixedReplyBoundaries(reply, { prompt: context.prompt, identityMarkdown: runtime.identityMarkdown });
  }
  async describeImage(image, signal, { question, executionSnapshot } = {}) {
    if (image.type === 'face' || image.kind === 'sticker')
      throw new ChannelError('STICKER_VISION_SKIPPED', '表情包不调用图像理解');
    const result = await this.run({
      text:
        promptText("vision/requests.json", "runner-text-1") +
        imageQualityContext([image]) +
        (question ? promptText("vision/requests.json", "runner-text-2") + JSON.stringify({ question }) : ''),
      images: [image],
      signal,
      mode: 'vision',
      executionSnapshot,
      systemOverride:
        promptText("vision/requests.json", "runner-systemOverride-3"),
    });
    return result.text;
  }
  async describeImages(images, signal) {
    if (images.some((image) => image.type === 'face' || image.kind === 'sticker'))
      throw new ChannelError('STICKER_VISION_SKIPPED', '表情包不调用图像理解');
    if (images.length === 1) return [await this.describeImage(images[0], signal)];
    const result = await this.run({
      text: promptText("vision/requests.json", "runner-text-4", [images.length, imageQualityContext(images)]),
      images,
      signal,
      mode: 'vision',
      systemOverride:
        promptText("vision/requests.json", "runner-systemOverride-5"),
    });
    let values;
    try {
      values = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {}
    if (
      !Array.isArray(values) ||
      values.length !== images.length ||
      values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 1500)
    )
      throw new ChannelError(
        'IMAGE_DESCRIPTION_FAILED',
        '模型返回的图像说明与图片数量不匹配，未混用图片内容，可稍后重新理解'
      );
    return values;
  }
  async describeStickers(images, signal) {
    if (!Array.isArray(images) || !images.length || images.length > 4)
      throw new ChannelError('STICKER_DESCRIPTION_INVALID', '每次最多理解四张已保存表情');
    const result = await this.run({
      text: promptText('vision/requests.json', 'sticker-text', [images.length]), images, signal, mode: 'vision',
      systemOverride: promptText('vision/requests.json', 'sticker-system'),
    });
    return stickerDescriptions(result.text, images.length);
  }
  async summarize(text, maxChars, signal, retry = {}) {
    const result = await this.run({
      ...memoryCompressionPrompt(text, maxChars, retry),
      signal,
      mode: 'memory',
      executionSnapshot: retry.executionSnapshot,
    });
    return result.text;
  }
  async memoryExecutionSnapshot(signal) {
    signal.throwIfAborted();
    const runtime = structuredClone(this.getRuntimeSettings() ?? {});
    const chosen = structuredClone(this.getModelChoice());
    const selection = chosen ? await availableModel(this.ctx, chosen, signal) : structuredClone(this.defaultSelection());
    return { runtime, selection };
  }
  async run(request) { return runLocalAgent(this, request); }
}
