import Pusher from 'pusher-js/node.js';
import { EventEmitter } from 'events';

/**
 * WebSocket client for the FixMyUI Reverb server.
 *
 * Emits:
 *   'job'        (payload)   — new job received from the SaaS
 *   'connected'  ()          — WebSocket connection established
 *   'error'      (err)       — connection or subscription error
 */
export class ReverbClient extends EventEmitter {
  #pusher = null;
  #channel = null;
  #config;

  /**
   * @param {import('../Config.js').Config} config
   */
  constructor(config) {
    super();
    this.#config = config;
  }

  /**
   * Connect to Reverb and subscribe to the agent's private channel.
   * The installation ID is resolved from the SaaS via the broadcastAuth endpoint
   * — Pusher sends the socket_id automatically when subscribing.
   *
   * @param {string} installationId  The numeric installation ID from the dashboard
   */
  connect(installationId) {
    const { apiUrl, agentSecret, reverbAppKey, reverbHost, reverbPort, reverbScheme } = this.#config;

    // First argument must be REVERB_APP_KEY (public client key), NOT REVERB_APP_ID.
    if (!reverbAppKey) {
      this.emit('error', new Error('Missing reverbAppKey. Run `fixmyui init` again or set FIXMYUI_REVERB_APP_KEY.'));
      return;
    }

    const url = new URL(apiUrl);
    const scheme = reverbScheme ?? (url.protocol === 'https:' ? 'https' : 'http');
    const useTLS = scheme === 'https';
    const wsHost = reverbHost ?? url.hostname;
    const wsPort = reverbPort ?? (useTLS ? 443 : 8080);

    this.#pusher = new Pusher(reverbAppKey, {
      wsHost,
      wsPort,
      wssPort:           wsPort,
      forceTLS:          useTLS,
      enabledTransports: ['ws', 'wss'],
      disableStats:      true,
      cluster:           'mt1',

      channelAuthorization: {
        customHandler: async ({ socketId, channelName }, callback) => {
          try {
            const res = await fetch(`${apiUrl}/api/fixmyui/agent/broadcasting/auth`, {
              method:  'POST',
              headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${agentSecret}`,
              },
              body: JSON.stringify({ socket_id: socketId, channel_name: channelName }),
            });

            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              callback(new Error(`Auth failed (${res.status}): ${body.error ?? 'Unauthorized'}`), null);
              return;
            }

            callback(null, await res.json());
          } catch (err) {
            callback(err, null);
          }
        },
      },
    });

    this.#pusher.connection.bind('connected', () => {
      this.emit('connected');
    });

    this.#pusher.connection.bind('error', (err) => {
      this.emit('error', err);
    });

    this.#pusher.connection.bind('disconnected', () => {
      this.emit('disconnected');
    });

    const channelName = `private-fixmyui.agent.${installationId}`;
    this.#channel = this.#pusher.subscribe(channelName);

    this.#channel.bind('pusher:subscription_error', (err) => {
      this.emit('error', new Error(`Channel subscription failed: ${JSON.stringify(err)}`));
    });

    // The SaaS broadcasts with broadcastAs() = 'new-job'
    // Pusher prepends the class namespace, so the event name is 'new-job'
    this.#channel.bind('new-job', (payload) => {
      this.emit('job', payload);
    });
  }

  /**
   * Gracefully disconnect from Reverb.
   */
  disconnect() {
    if (this.#pusher) {
      this.#pusher.disconnect();
      this.#pusher = null;
    }
  }

  /**
   * Resolve the installation ID from the SaaS by checking the agent secret.
   * Makes a broadcastAuth call and extracts the installation ID encoded in the auth response.
   *
   * Since we need the installation ID to subscribe but it's not stored locally,
   * we call a lightweight discovery endpoint first.
   *
   * @returns {Promise<string>} installation ID
   */
  static async resolveInstallationId(config) {
    // The SaaS encodes the installation ID in the expected channel name.
    // We can't subscribe without it — so the agent stores it in .fixmyui.json after init.
    // This method is used by `fixmyui init` to discover it.
    throw new Error(
      'Installation ID must be provided in .fixmyui.json (set during `fixmyui init`).'
    );
  }
}
