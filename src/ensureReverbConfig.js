import { SaasClient } from './SaasClient.js';

/**
 * If reverbAppKey is missing, fetch Reverb connection settings from GET /api/fixmyui/agent/me.
 *
 * @param {import('./Config.js').Config} config
 * @returns {Promise<import('./Config.js').Config>}
 */
export async function ensureReverbConfig(config) {
  if (config.reverbAppKey) {
    return config;
  }

  const saas = new SaasClient(config);
  const me = await saas.me();

  if (!me.reverb?.key) {
    throw new Error(
      'SaaS did not return Reverb settings. Update FixMyUI SaaS, or set FIXMYUI_REVERB_APP_KEY in .env.'
    );
  }

  const remoteConfig = me.config ?? {};

  return {
    ...config,
    reverbAppKey: me.reverb.key,
    reverbHost:   config.reverbHost   ?? me.reverb.host,
    reverbPort:   config.reverbPort   ?? me.reverb.port,
    reverbScheme: config.reverbScheme ?? me.reverb.scheme,
    promptRules:  remoteConfig.prompt_rules ?? config.promptRules ?? null,
  };
}
