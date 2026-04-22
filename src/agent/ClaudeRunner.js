import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const CLAUDE_PERMISSION_MODES = new Set([
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
  'auto',
]);

// Maximum tail (in bytes) we keep from Claude's stderr/stdout to attach to a
// crash report. 4 KB is enough to surface auth errors, model-not-found, quota
// messages, MCP failures, etc. without overflowing the SaaS payload.
const STREAM_TAIL_BYTES = 4096;

/**
 * Bounded ring-buffer that keeps only the last N bytes of a streamed text
 * source. Used to capture the tail of Claude's stderr/stdout so we can ship
 * it to the SaaS when the process exits non-zero — without keeping every
 * line in memory.
 */
class TailBuffer {
  #limit;
  #parts = [];
  #length = 0;

  constructor(limit = STREAM_TAIL_BYTES) {
    this.#limit = limit;
  }

  push(chunk) {
    if (!chunk) return;
    const text = String(chunk);
    if (!text) return;
    this.#parts.push(text);
    this.#length += text.length;
    while (this.#length > this.#limit && this.#parts.length > 1) {
      const dropped = this.#parts.shift();
      this.#length -= dropped.length;
    }
  }

  toString() {
    const joined = this.#parts.join('');
    if (joined.length <= this.#limit) return joined;
    return joined.slice(joined.length - this.#limit);
  }
}

/**
 * Spawns the `claude` CLI and parses its `--output-format stream-json` output.
 *
 * Emits:
 *   'thinking'  (text)    — Claude is reasoning internally
 *   'action'    (text)    — Claude is writing code / using a tool
 *   'info'      (text)    — Other informational output
 *   'stderr'    (text)    — A line from Claude's stderr (warning or fatal)
 *   'result'    (text)    — Final summary when Claude finishes
 *   'error'     (Error)   — Process error or non-zero exit. The Error is
 *                           enriched with `code`, `stderrTail`, `stdoutTail`
 *                           and an already-formatted `details` string suitable
 *                           for forwarding to the SaaS as a fail payload.
 *   'done'      ()        — Process exited cleanly
 */
export class ClaudeRunner extends EventEmitter {
  #proc = null;
  #repoPath;
  #permissionMode;
  #claudeModel;
  #tokenUsage = { input: 0, output: 0 };
  #stderrTail = new TailBuffer();
  #stdoutTail = new TailBuffer();

  /**
   * @param {import('../Config.js').Config} config
   * @param {object} [opts]
   * @param {string|null} [opts.claudeModel]  Slug forwarded as `claude --model`.
   *   When falsy or 'auto' the flag is omitted and Claude Code uses its default.
   */
  constructor(config, opts = {}) {
    super();
    this.#repoPath = config.repoPath;
    const mode = config.claudePermissionMode ?? 'acceptEdits';
    this.#permissionMode = CLAUDE_PERMISSION_MODES.has(mode) ? mode : 'acceptEdits';
    this.#claudeModel = opts.claudeModel || null;
  }

  /**
   * Spawn the `claude` CLI with the given prompt.
   * Non-blocking — listen to events for progress.
   *
   * Note: the prompt text is built server-side by the SaaS
   * (App\Modules\Fixmyui\Services\FixmyuiPromptBuilder). The agent only spawns
   * Claude with what it receives in the `new-job` payload (`compiled_prompt`).
   *
   * @param {string} prompt
   */
  run(prompt) {
    // `-p` = non-interactive. stream-json requires `--verbose`.
    // `--permission-mode` avoids blocking on "approve file edit?" when there is no TTY (FixMyUI agent).
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', this.#permissionMode,
    ];

    // Forward the per-job model selection. We omit `--model` when the SaaS
    // sends 'auto' (the default) so Claude Code falls back to its own
    // built-in default model.
    if (this.#claudeModel && this.#claudeModel !== 'auto') {
      args.push('--model', this.#claudeModel);
    }

    this.#proc = spawn('claude', args, {
      cwd:   this.#repoPath,
      env:   process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let resultText = '';

    this.#proc.stdout.setEncoding('utf8');
    this.#proc.stdout.on('data', (chunk) => {
      this.#stdoutTail.push(chunk);
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.#parseLine(trimmed, (type, text) => {
          if (type === 'result') resultText = text;
          this.emit(type, text);
        });
      }
    });

    this.#proc.stderr.setEncoding('utf8');
    this.#proc.stderr.on('data', (chunk) => {
      // Buffer raw bytes so we can report the full tail on crash, even
      // when there is no trailing newline (Claude writes to stderr in
      // chunks, not always line-delimited).
      this.#stderrTail.push(chunk);
      const text = chunk.trim();
      if (text) this.emit('stderr', text);
    });

    this.#proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        this.emit('error', this.#buildCrashError(
          '`claude` command not found. Install Claude Code: https://docs.anthropic.com/en/docs/claude-code',
          null,
        ));
      } else {
        this.emit('error', this.#buildCrashError(err.message || String(err), null));
      }
    });

    this.#proc.on('close', (code) => {
      if (code !== 0) {
        this.emit('error', this.#buildCrashError(`claude exited with code ${code}`, code));
      } else {
        this.emit('done', resultText, this.#tokenUsage);
      }
    });
  }

  /**
   * Build a rich Error suitable for forwarding to the SaaS:
   *   .message       short headline shown in the widget bubble
   *   .code          process exit code (null for spawn errors)
   *   .stderrTail    last STREAM_TAIL_BYTES of Claude's stderr (raw)
   *   .stdoutTail    last STREAM_TAIL_BYTES of Claude's stdout (raw)
   *   .details       human-readable dump of stderr (with stdout fallback)
   *                  — already formatted, ready to ship to the API
   */
  #buildCrashError(headline, code) {
    const err = new Error(headline);
    err.code = code;
    err.stderrTail = this.#stderrTail.toString();
    err.stdoutTail = this.#stdoutTail.toString();
    err.details = this.#formatCrashDetails(err);
    return err;
  }

  #formatCrashDetails(err) {
    const sections = [];
    const stderr = (err.stderrTail || '').trim();
    const stdout = (err.stdoutTail || '').trim();

    if (stderr) {
      sections.push(`stderr (last ${STREAM_TAIL_BYTES} bytes):\n${stderr}`);
    }
    // Only include stdout when stderr is empty — a successful stream-json
    // run produces lots of structured stdout that would just be noise here.
    if (!stderr && stdout) {
      sections.push(`stdout (last ${STREAM_TAIL_BYTES} bytes):\n${stdout}`);
    }

    if (sections.length === 0) {
      return 'No output was captured from the `claude` process before it exited. '
        + 'Try running `claude -p "ping"` in the same shell as the agent to verify '
        + 'authentication and CLI version.';
    }

    return sections.join('\n\n');
  }

  /**
   * Kill the running Claude process (e.g. on shutdown).
   */
  kill() {
    if (this.#proc) {
      this.#proc.kill('SIGTERM');
      this.#proc = null;
    }
  }

  // ── Stream-JSON parser ────────────────────────────────────────────────────

  #parseLine(line, emit) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON line (startup messages, etc.) — emit as info
      emit('info', line);
      return;
    }

    const type = event.type;

    // Claude Code stream-json event types:
    // https://docs.anthropic.com/en/docs/claude-code/sdk#streaming-json-format

    if (type === 'assistant') {
      const content = event.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'thinking') {
          emit('thinking', block.thinking ?? '');
        } else if (block.type === 'tool_use') {
          const name  = block.name ?? 'tool';
          const input = block.input ?? {};
          const desc  = toolDescription(name, input);
          emit('action', desc);
        } else if (block.type === 'text' && block.text) {
          emit('info', block.text);
        }
      }
    } else if (type === 'result') {
      const text = event.result ?? '';
      const usage = event.usage ?? event.message?.usage;
      if (usage) {
        this.#tokenUsage.input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
        this.#tokenUsage.output = usage.output_tokens ?? usage.completion_tokens ?? 0;
      }
      emit('result', text);
    } else if (type === 'system') {
      // system prompt confirmation — ignore
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toolDescription(name, input) {
  switch (name) {
    case 'str_replace_editor':
    case 'create_file':
    case 'write_file':
      return `Writing ${input.path ?? input.file_path ?? 'file'}`;
    case 'bash':
    case 'run_bash_command':
      return `Running: ${(input.command ?? input.cmd ?? '').slice(0, 80)}`;
    case 'read_file':
      return `Reading ${input.path ?? input.file_path ?? 'file'}`;
    case 'list_directory':
      return `Listing ${input.path ?? '.'}`;
    case 'search_files':
    case 'grep':
      return `Searching for "${input.pattern ?? input.query ?? ''}"`;
    default:
      return `Using tool: ${name}`;
  }
}
