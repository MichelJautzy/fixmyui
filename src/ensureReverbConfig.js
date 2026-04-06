import { SaasClient } from './SaasClient.js';
import { applyRemoteConfig } from './remoteConfig.js';

/**
 * Fetch Reverb connection settings + agent-relevant config from GET /api/fixmyui/agent/me.
 * Always called at startup; skips the HTTP call only if Reverb key is already present
 * AND env vars cover all agent-relevant fields (rare).
 *
 * @param {import('./Config.js').Config} config
 * @returns {Promise<import('./Config.js').Config>}
 */
export async function ensureReverbConfig(config) {
  const saas = new SaasClient(config);
  const me = await saas.me();

  if (!me.reverb?.key) {
    throw new Error(
      'SaaS did not return Reverb settings. Update FixMyUI SaaS, or set FIXMYUI_REVERB_APP_KEY in .env.'
    );
  }

  const merged = {
    ...config,
    reverbAppKey: config.reverbAppKey ?? me.reverb.key,
    reverbHost:   config.reverbHost   ?? me.reverb.host,
    reverbPort:   config.reverbPort   ?? me.reverb.port,
    reverbScheme: config.reverbScheme ?? me.reverb.scheme,
  };

  applyRemoteConfig(merged, me.config ?? {});

  return merged;
}
