import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'yaml';

/** Opt-in test helper. Reads only model settings, never account/session data.
 * Credentials stay in memory until saved by the isolated test's encrypted store.
 * This file is excluded from the desktop package. */
export function readPluginModels() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const read = name => fs.readFileSync(path.join(home, name), 'utf8');
  const location = JSON.parse(read('wechat-agent/location.json'));
  const config = parse(fs.readFileSync(path.join(location.root, 'config.yaml'), 'utf8'));
  const entries = parse(read('profiles/desktop/cordis.patch.yml'));
  const catalog = entries.find(entry => entry.id === 'llm-pi-ai')?.config?.providers ?? {};
  const selection = config.modelChoice ?? entries.find(entry => entry.id === 'agent-default-model')?.config;
  if (!selection?.provider || !catalog[selection.provider]) throw new Error('The plugin model is not a configured API provider');
  const refs = parse(read('.credentials.yaml')).refs;
  const providers = [...new Set([selection.provider, config.modelConfig?.visionModel?.provider].filter(Boolean))].map(id => {
    const value = catalog[id];
    if (!value?.baseURL || !refs[value.apiKeyEnv]) throw new Error('Selected plugin provider has no API endpoint or credential');
    return { provider: { id, name: value.displayName || id, baseURL: value.baseURL, stream: true,
      models: value.models.map(model => ({ id: model.id, name: model.name || model.id,
        vision: model.input?.includes('image') === true, reasoningEfforts: Object.values(model.reasoningEfforts || {}).filter(Boolean) })) },
      api: value.api, apiKey: refs[value.apiKeyEnv] };
  });
  return { selection: structuredClone(selection), modelConfig: structuredClone(config.modelConfig), providers,
    searchKey: refs.WECHAT_AGENT_TAVILY_API_KEY,
    imageGeneration: structuredClone(config.imageGeneration),
    imageCredentials: Object.fromEntries(Object.entries(refs).filter(([key]) => key.startsWith('WECHAT_AGENT_IMAGE_GENERATION_API_KEY_'))) };
}
