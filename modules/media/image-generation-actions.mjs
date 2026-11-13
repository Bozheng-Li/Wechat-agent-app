import { imageGenerationSettings } from '../../shared/image-generation.mjs';
import { ChannelError } from '../../shared/contracts.mjs';
import { preserveTimeValues } from '../../shared/time-settings.mjs';

export const endpoints = ['imageGeneration.configure', 'imageGeneration.credential'];

/** Image generation serves朋友圈素材与配图; one endpoint per configured interface. */
export async function imageGenerationMutation({ store, channel, lifetime, assertLive, status }, endpoint, payload, signal) {
  const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
  assertLive(combined); store.config.assertCurrent();
  if (!channel?.imageGeneration) throw new ChannelError('IMAGE_GENERATION_UNAVAILABLE', '生图组件尚未就绪');
  if (endpoint === 'imageGeneration.configure') {
    const settings = imageGenerationSettings(payload.settings), next = store.config.snapshot(store.data);
    if (payload.preserveTimeSettings) settings.providers = settings.providers.map(provider => preserveTimeValues('provider', provider, next.imageGeneration.providers.find(row => row.id === provider.id)));
    next.imageGeneration = settings; store.config.commit(next);
    await channel.imageGeneration.refreshCredential();
  } else if (endpoint === 'imageGeneration.credential') await channel.imageGeneration.configureCredential(payload.apiKey, combined, { providerId: payload.providerId, endpoint: payload.endpoint });
  assertLive(combined); return status();
}
