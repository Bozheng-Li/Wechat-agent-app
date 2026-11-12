import { workModelTools } from '../tools/index.mjs';
import { readPrompt } from '../../prompts/loader.mjs';

/** Only explicit app tools are exposed; no shell, host filesystem or external harness. */
export class AppWorkRunner {
  constructor(chatRunner) { this.chatRunner = chatRunner; }
  async run(options) {
    const { request, signal, onSession, assertAllowed, onBeforeTool, memoryTools = [], imageMemoryTools = [] } = options;
    const definitions = workModelTools({ ...options, surface: 'native' });
    const config = this.chatRunner.getRuntimeSettings()?.modelConfig ?? {};
    if (config.webSearch) definitions.push(this.chatRunner.searchTool(config, { assertAllowed }));
    return this.chatRunner.run({ text: request, mode: 'local-work', signal, onSession, assertAllowed, onBeforeTool,
      tools: definitions, systemOverride: readPrompt('work/system.md'),
      history: [], sessionId: options.sessionId });
  }
}
