import fs from 'node:fs';
import path from 'node:path';
import { startApplication } from './application.mjs';
import { CredentialStore } from '../platform/credentials.mjs';
import { ModelProviders } from '../platform/providers.mjs';
import { ModelClient } from '../../modules/agent/model-client.mjs';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { describeDataRoot, planSwitch, applySwitch, readLocation, pluginRoot } from '../storage/data-root.mjs';

export async function createDesktopApplication({ dataHome, home = dataHome, dshHome, encryption }) {
  const root = path.resolve(dataHome);
  const pointerHome = path.resolve(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const credentials = new CredentialStore(root, encryption);
  const providers = new ModelProviders(root, credentials);
  const ctx = { dataHome: root, credentials, llm: providers,
    agentDefaultModel: { currentSelection: () => providers.defaultSelection() },
    capabilities: { vision: true, webSearch: true, nativeWork: false },
  };
  const application = await startApplication(ctx);
  const operations = new Set(); const lifetime = new AbortController(); let closing;
  const call = async (endpoint, payload = {}, signal = new AbortController().signal) => {
    const combined = AbortSignal.any([signal, lifetime.signal]);
    try {
      combined.throwIfAborted();
      if (endpoint === 'providers.list') return { ok: true, value: await providers.list() };
      if (endpoint === 'models.catalog') return { ok: true, value: await providers.catalog() };
      if (endpoint === 'providers.save') {
        const value = await providers.save(payload.provider, payload.apiKey);
        // A freshly saved key retires earlier "缺少密钥" failures on memory pages.
        if (payload.apiKey) { try { application.service?.clearCredentialErrors?.(); } catch {} }
        return { ok: true, value };
      }
      if (endpoint === 'providers.delete') return { ok: true, value: await providers.remove(payload.provider) };
      if (endpoint === 'providers.discover')
        return { ok: true, value: await providers.discover({ id: payload.provider, baseURL: payload.baseURL, apiKey: payload.apiKey }, combined) };
      if (endpoint === 'providers.test') {
        const selection = { provider: payload.provider, model: payload.model };
        const result = await new ModelClient(providers).complete({ selection, signal: AbortSignal.any([combined, AbortSignal.timeout(45000)]),
          messages: [{ role: 'user', content: '请只回复 OK，用于验证模型连接。' }], maxTokens: 1024 });
        if (result.finishReason !== 'stop') throw new ChannelError('MODEL_TEST_INCOMPLETE', '模型连接已建立，但本次测试未正常完成');
        return { ok: true, value: { connected: true, model: selection.model, message: '模型连接成功' } };
      }
      if (endpoint === 'storage.data-root') {
        const location = readLocation(pointerHome);
        const plugin = pluginRoot(dshHome);
        const pluginDescribed = plugin ? describeDataRoot(plugin.root, { current: root }) : undefined;
        return { ok: true, value: {
          current: describeDataRoot(root),
          pointer: location ? { root: location.root, storeId: location.storeId, pending: location.pending } : undefined,
          lastSwitchError: location?.lastSwitchError,
          plugin: pluginDescribed ? { ...pluginDescribed, storeId: pluginDescribed.storeId || plugin.storeId } : undefined,
          sameAsPlugin: Boolean(plugin && plugin.root === root),
        } };
      }
      if (endpoint === 'storage.data-root.switch') {
        const plan = planSwitch(pointerHome, {
          target: payload.target,
          mode: payload.mode === 'copy' ? 'copy' : 'use',
          confirm: payload.confirm === true,
        });
        applySwitch(pointerHome, plan);
        return { ok: true, value: {
          restartRequired: true,
          target: plan.target,
          mode: plan.mode,
          accounts: plan.accounts,
          sharedAccounts: plan.sharedAccounts,
        } };
      }
      const result = await application.call(endpoint, payload, combined);
      if (result.ok && result.value && ['status', 'model.select', 'model.configure', 'settings'].includes(endpoint)) {
        result.value.app = { standalone: true, dataHome: root };
      }
      return result;
    } catch (error) { return { ok: false, error: publicError(error, '操作未完成，请检查本地应用状态') }; }
  };
  return {
    call(endpoint, payload, signal) {
      const operation = call(endpoint, payload, signal); operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch(() => {}); return operation;
    },
    close() { return closing ??= (async () => { lifetime.abort(); await Promise.allSettled([...operations]); await application.close(); })(); },
  };
}
