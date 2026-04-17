import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { ReverbClient } from './ReverbClient.js';
import { ClaudeRunner } from './ClaudeRunner.js';
import { GitHelper } from './GitHelper.js';
import {
  prefetchAttachments,
  rewritePromptWithLocalScreenshots,
} from './ScreenshotPrefetcher.js';
import { SaasClient } from '../SaasClient.js';
import { applyRemoteConfig } from '../remoteConfig.js';

const execFileAsync = promisify(execFile);

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
  #activeJobId = null;
  #cancelledJobs = new Set();

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

    this.#reverb.on('job-cancel', (payload) => {
      this.handleJobCancel(payload).catch((err) => {
        this.log(`[fixmyui] Unhandled cancel error: ${err.message}`);
      });
    });

    this.#reverb.connect(installationId);
  }

  /**
   * Handle a 'job-cancel' event broadcast from the SaaS.
   * Kills Claude (SIGTERM), applies the configured stop_behavior, and reports
   * a cancelled fail to the SaaS (idempotent — SaaS already marked it cancelled).
   */
  async handleJobCancel(payload) {
    const { job_id, stop_behavior = 'git_stash' } = payload || {};
    if (!job_id) return;

    this.#cancelledJobs.add(job_id);

    if (this.#activeJobId !== job_id) {
      this.log(`[fixmyui] job-cancel for ${job_id}: not the active job (current=${this.#activeJobId ?? 'none'}), ignoring process kill.`);
      return;
    }

    this.log(`[fixmyui] Cancellation requested for job ${job_id} (stop_behavior=${stop_behavior})`);

    if (this.#activeRunner) {
      try { this.#activeRunner.kill(); } catch { /* best-effort */ }
      this.#activeRunner = null;
    }

    await this.#applyStopBehavior(job_id, stop_behavior).catch((err) => {
      this.log(`[fixmyui] stop_behavior error: ${err.message}`);
    });

    await this.#saas.fail(job_id, 'Cancelled by user', { cancelled: true }).catch(() => {});
  }

  /**
   * Execute the configured stop_behavior in the agent's repo.
   *   git_restore  → restore --staged . && restore . (DISCARDS changes)
   *   git_stash    → git stash push -u -m "fixmyui-job-{id}" (REVERSIBLE)
   *   none         → do nothing
   */
  async #applyStopBehavior(jobId, stopBehavior) {
    const repo = this.#config.repoPath;
    if (stopBehavior === 'none') return;

    if (stopBehavior === 'git_stash') {
      try {
        const label = `fixmyui-job-${String(jobId).slice(0, 8)}`;
        await execFileAsync('git', ['stash', 'push', '-u', '-m', label], { cwd: repo, maxBuffer: 4 * 1024 * 1024 });
        this.log(`[fixmyui] Stashed uncommitted changes as "${label}"`);
      } catch (err) {
        if (!/No local changes to save/i.test(err?.stderr ?? err?.message ?? '')) throw err;
      }
      return;
    }

    if (stopBehavior === 'git_restore') {
      await execFileAsync('git', ['restore', '--staged', '.'], { cwd: repo, maxBuffer: 4 * 1024 * 1024 }).catch(() => {});
      await execFileAsync('git', ['restore', '.'], { cwd: repo, maxBuffer: 4 * 1024 * 1024 });
      this.log('[fixmyui] Restored working tree (uncommitted changes discarded).');
      return;
    }

    this.log(`[fixmyui] Unknown stop_behavior "${stopBehavior}" — skipping.`);
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

    const { job_id, message, page_url, screenshot_url, attachments, compiled_prompt } = payload;
    const {
      branchStrategy, branchPrefix, branchName: fixedBranchName,
      autoPush, previewUrlTemplate, repoPath, postCommands,
    } = this.#config;

    // Normalise attachments. Modern SaaS (>= 2026-04-16) ships `attachments`
    // as an array of { url, name }. Older deployments only send
    // `screenshot_url`: fall back to a single-item list for consistency.
    const attachmentList = Array.isArray(attachments) && attachments.length > 0
      ? attachments
          .map((a) => (typeof a === 'string' ? { url: a } : a))
          .filter((a) => a && typeof a.url === 'string' && a.url.length > 0)
      : (screenshot_url ? [{ url: screenshot_url }] : []);

    this.log(`\n[fixmyui] Job ${job_id} received: "${message}"`);
    if (page_url) this.log(`  [context] Page: ${page_url}`);
    if (attachmentList.length === 1) {
      this.log(`  [context] Image: ${attachmentList[0].url}`);
    } else if (attachmentList.length > 1) {
      this.log(`  [context] ${attachmentList.length} images:`);
      attachmentList.forEach((a, i) => this.log(`    ${i + 1}. ${a.url}`));
    }

    if (!compiled_prompt || typeof compiled_prompt !== 'string') {
      const err = new Error('Job payload missing compiled_prompt — the SaaS version is too old for this agent. Expected compiled_prompt built server-side.');
      this.log(`[fixmyui] ${err.message}`);
      await this.#saas.fail(job_id, err.message).catch(() => {});
      return;
    }

    let activeBranch = null;
    /** @type {Array<{url: string, localPath: string, cleanup: () => Promise<void>}>} */
    let prefetchedAttachments = [];
    this.#activeJobId = job_id;

    try {
      if (this.#cancelledJobs.has(job_id)) {
        this.log(`[fixmyui] Job ${job_id} was cancelled before starting — skipping.`);
        return;
      }

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

      // ── 2. Prompt comes compiled from the SaaS (single source of truth) ─
      //       Then locally rewrite each image URL to a downloaded file so
      //       Claude can Read them without needing any network permission.
      let prompt = compiled_prompt;

      if (attachmentList.length > 0) {
        const label = attachmentList.length === 1
          ? 'Downloading screenshot…'
          : `Downloading ${attachmentList.length} images…`;
        await this.#saas.progress(job_id, label, 'info').catch(() => {});

        prefetchedAttachments = await prefetchAttachments(attachmentList, {
          repoPath,
          jobId: job_id,
          onError: (url, err) => {
            this.log(`[fixmyui] Warning: prefetch failed for ${url} (${err.message}) — Claude will try the URL directly.`);
          },
        });

        if (prefetchedAttachments.length > 0) {
          prompt = rewritePromptWithLocalScreenshots(prompt, prefetchedAttachments);
          prefetchedAttachments.forEach((pre, i) => {
            this.log(`  [image ${i + 1}] Prefetched to ${pre.localPath}`);
          });
        }

        if (prefetchedAttachments.length < attachmentList.length) {
          await this.#saas.progress(
            job_id,
            `Some images could not be prefetched (${prefetchedAttachments.length}/${attachmentList.length}) — Claude will try the URL(s) directly.`,
            'info',
          ).catch(() => {});
        }
      }

      // ── 3. Run Claude with streaming progress ───────────────────────────
      await this.#saas.progress(job_id, 'Claude is starting…', 'info');
      const jobStartTime = Date.now();
      const { resultText, tokenUsage } = await this.#runClaude(job_id, prompt, repoPath);
      const durationSeconds = Math.round((Date.now() - jobStartTime) / 1000);

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
      const claudeCodeVersion = await this.#getClaudeCodeVersion();
      await this.#saas.complete(job_id, {
        result_message: resultText || `Changes applied on branch ${activeBranch}.`,
        branch:         isDirty ? activeBranch : null,
        preview_url:    previewUrl,
        claude_code_version: claudeCodeVersion,
        tokens_input:   tokenUsage?.input || null,
        tokens_output:  tokenUsage?.output || null,
        duration_seconds: durationSeconds,
      });

      this.log(`[fixmyui] Job ${job_id} completed.`);

    } catch (err) {
      if (this.#cancelledJobs.has(job_id)) {
        this.log(`[fixmyui] Job ${job_id} interrupted by cancellation (${err.message}).`);
      } else {
        this.log(`[fixmyui] Job ${job_id} failed: ${err.message}`);
        await this.#saas.fail(job_id, err.message).catch(() => {});
      }

      if (this.#originalBranch && branchStrategy !== 'local-branch') {
        await this.#git.checkoutExisting(this.#originalBranch).catch(() => {});
      }
    } finally {
      if (prefetchedAttachments.length > 0) {
        await Promise.all(
          prefetchedAttachments.map((p) => p.cleanup().catch(() => { /* best-effort */ })),
        );
      }
      if (this.#activeJobId === job_id) this.#activeJobId = null;
      this.#cancelledJobs.delete(job_id);
    }
  }

  /**
   * Best-effort: read `claude --version` for the dashboard (no throw).
   * @returns {Promise<string|null>}
   */
  async #getClaudeCodeVersion() {
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], {
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      const v = String(stdout).trim();
      if (!v) return null;
      return v.length > 120 ? v.slice(0, 120) : v;
    } catch {
      return null;
    }
  }

  /**
   * Run ClaudeRunner and forward all events as progress reports.
   * @returns {Promise<{resultText: string, tokenUsage: {input: number, output: number}}>}
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

      runner.on('done', (resultText, tokenUsage) => {
        this.#activeRunner = null;
        resolve({ resultText, tokenUsage });
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
