import { ChannelError, validateGlobalPersona, validateModelConfig } from "../../shared/contracts.mjs";
import { selectModel, visionSelection } from "./models.mjs";
import { savePersonaDraft, assertDistillSources } from './style-distill.mjs';
import { assertStylePrivacy } from './style-summary.mjs';

export const endpoints = ['search.credentials', 'identity.save', 'model.select', 'model.configure', 'persona.save',
  'persona.create', 'persona.select', 'persona.delete'];

export async function agentMutation(
  { ctx, store, runner, identity, lifetime, assertLive, paused, status, currentAccount },
  endpoint,
  payload,
  signal
) {
  switch (endpoint) {
    case 'search.credentials': {
      if (!runner?.search)
        throw new ChannelError('WEB_SEARCH_CREDENTIAL_STORE_MISSING', '搜索组件尚未就绪，密钥未保存。');
      await runner.search.configureCredential(
        payload.provider,
        payload.apiKey,
        AbortSignal.any([lifetime, ...(signal ? [signal] : [])])
      );
      break;
    }
    case 'identity.save': {
      const current = identity.validateEdit(payload.markdown, payload.revision);
      if (current.markdown !== payload.markdown)
        await paused('正在应用全局身份，旧任务已取消', () => {
          signal?.throwIfAborted();
          identity.edit(payload.markdown, payload.revision);
        });
      break;
    }
    case 'model.select':
      await selectModel(ctx, store, payload.selection, AbortSignal.any([lifetime, ...(signal ? [signal] : [])]));
      break;
    case 'model.configure': {
      const config = validateModelConfig(payload.modelConfig);
      if (config.vision && config.visionModel)
        await visionSelection(
          ctx,
          config.visionModel,
          config.visionModel,
          AbortSignal.any([lifetime, ...(signal ? [signal] : [])])
        );
      assertLive(signal);
      store.setModelConfig(config);
      break;
    }
    case 'persona.create': {
      const persona = validateGlobalPersona(payload.persona);
      const distilled = payload.source === 'distilled' || !!payload.draftToken;
      await paused('正在保存新人设，旧任务已取消', () => {
        assertLive(signal);
        if (distilled) {
          currentAccount(payload);
          savePersonaDraft(store, { ...payload, persona }, provenance =>
            store.createPersona({ persona, name: payload.name, source: 'distilled', provenance }));
        } else store.createPersona({ persona, name: payload.name, source: 'manual' });
        store.resetSessions();
      });
      break;
    }
    case 'persona.select': {
      if (typeof payload.id !== 'string' || payload.id !== store.personasView().activeId)
        await paused('正在切换人设，旧任务已取消', () => {
          signal?.throwIfAborted();
          store.resetSessions();
          store.selectPersona(payload.id);
        });
      break;
    }
    case 'persona.delete': {
      await paused('正在删除人设，旧任务已取消', () => {
        signal?.throwIfAborted();
        store.deletePersona(payload.id);
        store.resetSessions();
      });
      break;
    }
    case 'persona.save': {
      const persona = validateGlobalPersona(payload.persona);
      const activeId = store.activePersonaId();
      if (payload.id && payload.id !== activeId) throw new ChannelError('PERSONA_CHANGED', '当前人设已切换，请重新载入后保存。');
      const entry = store.personaEntries().find(row => row.id === activeId);
      const checkDerived = () => {
        if (store.activePersonaId() !== activeId) throw new ChannelError('PERSONA_CHANGED', '当前人设或来源授权已变化，请重新载入。');
        if (entry?.source === 'distilled') {
          currentAccount({ accountId: entry.provenance?.accountId });
          const source = assertDistillSources(store, entry.provenance);
          assertStylePrivacy(persona, { phrases: source.phrases });
        }
      };
      checkDerived();
      if (!activeId || JSON.stringify(persona) !== JSON.stringify(store.persona()))
        await paused('正在应用人设，旧任务已取消', () => {
          assertLive(signal);
          checkDerived();
          store.setPersona(persona);
          store.resetSessions();
        });
      break;
    }
  }
  assertLive(signal);
  return status();
}
