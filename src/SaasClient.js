/**
 * HTTP client for the FixMyUI SaaS API.
 * All agent-facing endpoints require Authorization: Bearer {agentSecret}.
 */
export class SaasClient {
  /**
   * @param {import('./Config.js').Config} config
   */
  constructor(config) {
    this.apiUrl      = config.apiUrl;
    this.agentSecret = config.agentSecret;
  }

  /**
   * Post a progress event for a job.
   * Maps to POST /api/fixmyui/agent/jobs/{id}/progress
   *
   * @param {string} jobId
   * @param {string} message
   * @param {'thinking'|'action'|'info'} [type]
   */
  async progress(jobId, message, type = 'info') {
    return this.#post(`/api/fixmyui/agent/jobs/${jobId}/progress`, { message, type });
  }

  /**
   * Mark a job as completed.
   * Maps to POST /api/fixmyui/agent/jobs/{id}/complete
   *
   * @param {string} jobId
   * @param {object} payload
   * @param {string} [payload.result_message]
   * @param {string} [payload.branch]
   * @param {string} [payload.preview_url]
   */
  async complete(jobId, { result_message, branch, preview_url, claude_code_version } = {}) {
    return this.#post(`/api/fixmyui/agent/jobs/${jobId}/complete`, {
      result_message,
      branch,
      preview_url,
      claude_code_version,
    });
  }

  /**
   * Mark a job as failed.
   * Maps to POST /api/fixmyui/agent/jobs/{id}/fail
   *
   * @param {string} jobId
   * @param {string} errorMessage
   */
  async fail(jobId, errorMessage) {
    return this.#post(`/api/fixmyui/agent/jobs/${jobId}/fail`, { error: errorMessage });
  }

  /**
   * Fetch the installation identity (used by `fixmyui init` to discover installationId).
   * GET /api/fixmyui/agent/me
   *
   * @returns {Promise<{installation_id: number, name: string, allowed_origin: string, is_active: boolean}>}
   */
  async me() {
    const res = await fetch(`${this.apiUrl}/api/fixmyui/agent/me`, {
      headers: this.#headers(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Authentication failed (${res.status}): ${body.error ?? 'Unauthorized'}`);
    }
    return res.json();
  }

  /**
   * Report a non-job error to the SaaS (startup failure, Reverb disconnect, etc.).
   * Best-effort: swallows all errors so it never crashes the agent.
   * Maps to POST /api/fixmyui/agent/error
   *
   * @param {string} message
   */
  async reportError(message) {
    try {
      await this.#post('/api/fixmyui/agent/error', { message: String(message).slice(0, 1000) });
    } catch { /* best-effort */ }
  }

  /**
   * Ping the SaaS — used by `fixmyui test`.
   * Attempts a broadcastAuth call with a dummy socket_id to verify credentials.
   */
  async ping() {
    const res = await fetch(`${this.apiUrl}/api/fixmyui/agent/broadcasting/auth`, {
      method:  'POST',
      headers: this.#headers(),
      body:    JSON.stringify({ socket_id: 'test.0', channel_name: 'test' }),
    });
    // 403 means auth passed, channel name not allowed (expected in a ping)
    // 401 means credentials are wrong
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Authentication failed: ${body.error ?? 'Unauthorized'}`);
    }
    return true;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async #post(path, body) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method:  'POST',
      headers: this.#headers(),
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = ` — ${(await res.json()).error}`; } catch { /* ignore */ }
      throw new Error(`SaaS API ${res.status} on ${path}${detail}`);
    }

    return res.json();
  }

  #headers() {
    return {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${this.agentSecret}`,
    };
  }
}
