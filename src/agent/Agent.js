import { ReverbClient } from './ReverbClient.js';
import { ClaudeRunner } from './ClaudeRunner.js';
import { GitHelper } from './GitHelper.js';
import { SaasClient } from '../SaasClient.js';

function formatWsError(err) {
  if (err == null) return 'unknown';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  if (err?.message) return err.message;
  if (err?.error?.message) return err.error.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Main FixMyUI agent.
 *
 * Lifecycle:
 *   1. connect()     — open WebSocket to Reverb, subscribe to agent channel
 *   2. on 'new-job'  — handleJob() orchestrates the full job pipeline
 *   3. disconnect()  — graceful shutdown
 */
export class Agent {
  #config;
  #saas;
  #reverb;
  #git;
  /** Branch checked out before the job (to restore on failure) */
  #originalBranch = null;
  /** Currently running ClaudeRunner (for graceful kill on shutdown) */
  #activeRunner = null;

  /**
   * @param {import('../Config.js').Config} config
   * @param {object} [options]
   * @param {function} [options.log]  Logger function (default: console.log)
   */
  constructor(config, { log = console.log } = {}) {
    this.#config = config;
    this.#saas   = new SaasClient(config);
    this.#git    = new GitHelper(config.repoPath);
    this.log     = log;
  }

  /**
   * Connect to Reverb and start listening for jobs.
   * @param {number|string} installationId
   */
  connect(installationId) {
    this.#reverb = new ReverbClient(this.#config);

    this.#reverb.on('connected', () => {
      this.log(`[fixmyui] Connected — listening for jobs on installation #${installationId}`);
    });

    this.#reverb.on('disconnected', () => {
      this.log('[fixmyui] WebSocket disconnected — will not reconnect automatically.');
    });

    this.#reverb.on('error', (err) => {
      this.log(`[fixmyui] WebSocket error: ${formatWsError(err)}`);
    });

    this.#reverb.on('job', (payload) => {
      this.handleJob(payload).catch((err) => {
        this.log(`[fixmyui] Unhandled job error: ${err.message}`);
      });
    });

    this.#reverb.connect(installationId);
  }

  /**
   * Handle a single job end-to-end.
   * @param {object} payload  The new-job event payload from Reverb
   */
  async handleJob(payload) {
    const { job_id, message, page_url, history = [] } = payload;
    const { branchPrefix, autoPush, previewUrlTemplate, repoPath } = this.#config;

    const branchSuffix = job_id.slice(0, 8);
    const branchName   = `${branchPrefix}/${branchSuffix}`;

    this.log(`\n[fixmyui] Job ${job_id} received: "${message}"`);

    try {
      // ── 0. Verify this is a git repo ──────────────────────────────────────
      await this.#git.assertIsRepo();
      this.#originalBranch = await this.#git.currentBranch();

      // ── 1. Create branch ──────────────────────────────────────────────────
      await this.#saas.progress(job_id, `Creating branch ${branchName}…`, 'info');
      await this.#git.checkoutBranch(branchName);
      this.log(`[fixmyui] Checked out ${branchName}`);

      // ── 2. Build Claude prompt ────────────────────────────────────────────
      const prompt = ClaudeRunner.buildPrompt({ pm_message: message, page_url, history });

      // ── 3. Run Claude with streaming progress ─────────────────────────────
      await this.#saas.progress(job_id, 'Claude is starting…', 'info');

      const resultText = await this.#runClaude(job_id, prompt, repoPath);

      // ── 4. Commit changes ─────────────────────────────────────────────────
      const isDirty = await this.#git.isDirty();
      let commitHash = null;

      if (isDirty) {
        await this.#saas.progress(job_id, 'Committing changes…', 'info');
        await this.#git.addAll();
        const commitMsg = `fixmyui: ${message.slice(0, 72)}`;
        commitHash = await this.#git.commit(commitMsg);
        this.log(`[fixmyui] Committed ${commitHash}`);
      } else {
        await this.#saas.progress(job_id, 'No file changes detected.', 'info');
      }

      // ── 5. Push ───────────────────────────────────────────────────────────
      if (autoPush && isDirty) {
        await this.#saas.progress(job_id, `Pushing ${branchName}…`, 'info');
        await this.#git.push(branchName);
        this.log(`[fixmyui] Pushed ${branchName}`);
      }

      // ── 6. Build preview URL ──────────────────────────────────────────────
      const previewUrl = previewUrlTemplate
        ? previewUrlTemplate.replace('{branch}', branchName)
        : null;

      // ── 7. Report success ─────────────────────────────────────────────────
      await this.#saas.complete(job_id, {
        result_message: resultText || `Changes applied on branch ${branchName}.`,
        branch:         isDirty ? branchName : null,
        preview_url:    previewUrl,
      });

      this.log(`[fixmyui] Job ${job_id} completed.`);

    } catch (err) {
      this.log(`[fixmyui] Job ${job_id} failed: ${err.message}`);

      // Best-effort: report failure to SaaS
      await this.#saas.fail(job_id, err.message).catch(() => {});

      // Best-effort: return to original branch
      if (this.#originalBranch) {
        await this.#git.checkoutExisting(this.#originalBranch).catch(() => {});
      }
    }
  }

  /**
   * Run ClaudeRunner and forward all events as progress reports.
   * @returns {Promise<string>} the final result text from Claude
   */
  #runClaude(jobId, prompt) {
    return new Promise((resolve, reject) => {
      const runner = new ClaudeRunner(this.#config);
      this.#activeRunner = runner;

      runner.on('thinking', async (text) => {
        this.log(`  [thinking] ${text.slice(0, 100)}`);
        await this.#saas.progress(jobId, text.slice(0, 900), 'thinking').catch(() => {});
      });

      runner.on('action', async (text) => {
        this.log(`  [action] ${text}`);
        await this.#saas.progress(jobId, text, 'action').catch(() => {});
      });

      runner.on('info', async (text) => {
        if (!text.trim()) return;
        this.log(`  [info] ${text.slice(0, 100)}`);
        await this.#saas.progress(jobId, text.slice(0, 900), 'info').catch(() => {});
      });

      runner.on('error', (err) => {
        this.#activeRunner = null;
        reject(err);
      });

      runner.on('done', (resultText) => {
        this.#activeRunner = null;
        resolve(resultText);
      });

      runner.run(prompt);
    });
  }

  /**
   * Gracefully disconnect and kill any running Claude process.
   */
  disconnect() {
    if (this.#activeRunner) {
      this.#activeRunner.kill();
      this.#activeRunner = null;
    }
    if (this.#reverb) {
      this.#reverb.disconnect();
    }
  }
}
