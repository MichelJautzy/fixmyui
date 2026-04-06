import { spawn } from 'child_process';
import { ReverbClient } from './ReverbClient.js';
import { ClaudeRunner } from './ClaudeRunner.js';
import { GitHelper } from './GitHelper.js';
import { SaasClient } from '../SaasClient.js';
import { applyRemoteConfig } from '../remoteConfig.js';

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
  #originalBranch = null;
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
      this.#saas.reportError('WebSocket disconnected — agent is no longer listening for jobs.');
    });

    this.#reverb.on('error', (err) => {
      const msg = formatWsError(err);
      this.log(`[fixmyui] WebSocket error: ${msg}`);
      this.#saas.reportError(`WebSocket error: ${msg}`);
    });

    this.#reverb.on('config-updated', (payload) => {
      applyRemoteConfig(this.#config, payload);
      this.log('[fixmyui] Config updated remotely — applied.');
    });

    this.#reverb.on('job', (payload) => {
      this.handleJob(payload).catch((err) => {
        this.log(`[fixmyui] Unhandled job error: ${err.message}`);
      });
    });

    this.#reverb.connect(installationId);
  }

  /**
   * Fetch fresh config from the SaaS and merge agent-relevant fields.
   * Env vars always take priority over remote values.
   */
  async syncRemoteConfig() {
    try {
      const me = await this.#saas.me();
      applyRemoteConfig(this.#config, me.config ?? {});
    } catch (err) {
      this.log(`[fixmyui] Warning: could not sync remote config — ${err.message}`);
    }
  }

  /**
   * Handle a single job end-to-end.
   * @param {object} payload  The new-job event payload from Reverb
   */
  async handleJob(payload) {
    await this.syncRemoteConfig();

    const { job_id, message, page_url, html_context, element_xpath, history = [] } = payload;
    const {
      branchStrategy, branchPrefix, branchName: fixedBranchName,
      autoPush, previewUrlTemplate, repoPath, postCommands,
    } = this.#config;

    this.log(`\n[fixmyui] Job ${job_id} received: "${message}"`);
    if (page_url) this.log(`  [context] Page: ${page_url}`);
    if (element_xpath) this.log(`  [context] XPath: ${element_xpath}`);
    if (html_context) this.log(`  [context] HTML: ${html_context.slice(0, 120)}${html_context.length > 120 ? '…' : ''}`);

    let activeBranch = null;

    try {
      // ── 0. Verify git repo ────────────────────────────────────────────────
      await this.#git.assertIsRepo();
      this.#originalBranch = await this.#git.currentBranch();

      // ── 1. Branch strategy ────────────────────────────────────────────────
      if (branchStrategy === 'same-branch') {
        activeBranch = fixedBranchName || 'fixmyui';
        await this.#saas.progress(job_id, `Switching to branch ${activeBranch}…`, 'info');
        await this.#git.checkoutOrCreate(activeBranch);
        this.log(`[fixmyui] On branch ${activeBranch}`);

      } else if (branchStrategy === 'local-branch') {
        activeBranch = this.#originalBranch;
        await this.#saas.progress(job_id, `Staying on branch ${activeBranch}`, 'info');
        this.log(`[fixmyui] Staying on ${activeBranch}`);

      } else {
        const branchSuffix = job_id.slice(0, 8);
        activeBranch = `${branchPrefix}/${branchSuffix}`;
        await this.#saas.progress(job_id, `Creating branch ${activeBranch}…`, 'info');
        await this.#git.checkoutBranch(activeBranch);
        this.log(`[fixmyui] Checked out ${activeBranch}`);
      }

      // ── 2. Build Claude prompt ──────────────────────────────────────────
      const prompt = ClaudeRunner.buildPrompt({
        pm_message: message, page_url, html_context, element_xpath, history,
        prompt_rules: this.#config.promptRules,
      });

      // ── 3. Run Claude with streaming progress ───────────────────────────
      await this.#saas.progress(job_id, 'Claude is starting…', 'info');
      const resultText = await this.#runClaude(job_id, prompt, repoPath);

      // ── 4. Commit changes ───────────────────────────────────────────────
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

      // ── 5. Push ─────────────────────────────────────────────────────────
      if (autoPush && isDirty) {
        await this.#saas.progress(job_id, `Pushing ${activeBranch}…`, 'info');
        await this.#git.push(activeBranch);
        this.log(`[fixmyui] Pushed ${activeBranch}`);
      }

      // ── 6. Post-completion commands ─────────────────────────────────────
      if (postCommands && postCommands.length > 0) {
        for (const cmd of postCommands) {
          await this.#runPostCommand(job_id, cmd, repoPath);
        }
      }

      // ── 7. Build preview URL ────────────────────────────────────────────
      const previewUrl = previewUrlTemplate
        ? previewUrlTemplate.replace('{branch}', activeBranch)
        : null;

      // ── 8. Report success ───────────────────────────────────────────────
      await this.#saas.complete(job_id, {
        result_message: resultText || `Changes applied on branch ${activeBranch}.`,
        branch:         isDirty ? activeBranch : null,
        preview_url:    previewUrl,
      });

      this.log(`[fixmyui] Job ${job_id} completed.`);

    } catch (err) {
      this.log(`[fixmyui] Job ${job_id} failed: ${err.message}`);
      await this.#saas.fail(job_id, err.message).catch(() => {});

      if (this.#originalBranch && branchStrategy !== 'local-branch') {
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
   * Run a single post-completion shell command, streaming output as progress.
   * @param {string} jobId
   * @param {{label: string, command: string}} cmd
   * @param {string} cwd
   * @returns {Promise<void>}
   */
  #runPostCommand(jobId, cmd, cwd) {
    return new Promise(async (resolve, reject) => {
      const label = cmd.label || cmd.command;
      this.log(`[fixmyui] Running post-command: ${label}`);
      await this.#saas.progress(jobId, `Running: ${label}`, 'shell').catch(() => {});

      const proc = spawn(cmd.command, {
        shell: true,
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', async (chunk) => {
        const text = chunk.trim();
        if (text) {
          this.log(`  [shell] ${text.slice(0, 200)}`);
          await this.#saas.progress(jobId, text.slice(0, 900), 'shell').catch(() => {});
        }
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', async (chunk) => {
        const text = chunk.trim();
        if (text) {
          this.log(`  [shell:err] ${text.slice(0, 200)}`);
          await this.#saas.progress(jobId, `[stderr] ${text.slice(0, 800)}`, 'shell').catch(() => {});
        }
      });

      proc.on('error', (err) => {
        this.log(`[fixmyui] Post-command error: ${err.message}`);
        reject(err);
      });

      proc.on('close', async (code) => {
        if (code !== 0) {
          const msg = `Post-command "${label}" exited with code ${code}`;
          this.log(`[fixmyui] ${msg}`);
          await this.#saas.progress(jobId, msg, 'shell').catch(() => {});
        }
        resolve();
      });
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
