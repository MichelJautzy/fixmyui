/**
 * Maps SaaS remote config (snake_case) onto the agent's in-memory config (camelCase).
 * Env vars always win — if a field was set via env, the remote value is ignored.
 *
 * @param {import('./Config.js').Config} config  Current in-memory config (mutated in place)
 * @param {object} remote  Agent-relevant fields from GET /api/fixmyui/agent/me → config
 * @returns {import('./Config.js').Config}  The same config object (for chaining)
 */
export function applyRemoteConfig(config, remote) {
  if (!remote || typeof remote !== 'object') return config;

  const mapping = [
    ['branch_strategy',       'branchStrategy',     'FIXMYUI_BRANCH_STRATEGY',       String],
    ['branch_name',           'branchName',         'FIXMYUI_BRANCH_NAME',           String],
    ['auto_push',             'autoPush',           'FIXMYUI_AUTO_PUSH',             Boolean],
    ['post_commands',         'postCommands',       null,                            Array],
    ['preview_url_template',  'previewUrlTemplate', 'FIXMYUI_PREVIEW_URL_TEMPLATE',  String],
    ['prompt_rules',          'promptRules',        null,                            String],
    ['ai_policies',           'aiPolicies',         null,                            Array],
    ['global_context',        'globalContext',       null,                            String],
  ];

  for (const [remoteKey, localKey, envKey, _type] of mapping) {
    if (!(remoteKey in remote)) continue;
    if (envKey && hasEnv(envKey)) continue;
    config[localKey] = remote[remoteKey] ?? config[localKey];
  }

  return config;
}

function hasEnv(key) {
  const v = process.env[key];
  return v !== undefined && v.trim() !== '';
}
