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

/**
 * Spawns the `claude` CLI and parses its `--output-format stream-json` output.
 *
 * Emits:
 *   'thinking'  (text)    — Claude is reasoning internally
 *   'action'    (text)    — Claude is writing code / using a tool
 *   'info'      (text)    — Other informational output
 *   'result'    (text)    — Final summary when Claude finishes
 *   'error'     (Error)   — Process error or non-zero exit
 *   'done'      ()        — Process exited cleanly
 */
export class ClaudeRunner extends EventEmitter {
  #proc = null;
  #repoPath;
  #permissionMode;

  /**
   * @param {import('../Config.js').Config} config
   */
  constructor(config) {
    super();
    this.#repoPath = config.repoPath;
    const mode = config.claudePermissionMode ?? 'acceptEdits';
    this.#permissionMode = CLAUDE_PERMISSION_MODES.has(mode) ? mode : 'acceptEdits';
  }

  /**
   * Build the task prompt for Claude from the job and conversation history.
   *
   * @param {object} job
   * @param {string}   job.pm_message
   * @param {string}   [job.page_url]
   * @param {string}   [job.html_context]  Outer HTML of the element the PM selected
   * @param {string}   [job.element_xpath] Full XPath of the selected element in the page DOM
   * @param {string}   [job.prompt_rules]  Admin-defined guardrails
   * @param {Array}    [job.history]  [{message, result, branch}, ...]
   * @returns {string}
   */
  static buildPrompt(job) {
    const lines = [];

    if (job.prompt_rules) {
      lines.push('RULES (from project admin — always follow):');
      lines.push(job.prompt_rules);
      lines.push('');
    }

    if (job.history && job.history.length > 0) {
      lines.push('Context — previous changes in this session:');
      job.history.forEach((turn, i) => {
        const branch = turn.branch ? ` (branch: ${turn.branch})` : '';
        lines.push(`  Turn ${i + 1}: "${turn.message}" → "${turn.result}"${branch}`);
      });
      lines.push('');
    }

    if (job.page_url) {
      lines.push(`Page: ${job.page_url}`);
    }

    if (job.html_context || job.element_xpath) {
      lines.push('');
      lines.push('Target element (selected by PM on the page):');
      if (job.element_xpath) {
        lines.push(`XPath: ${job.element_xpath}`);
      }
      if (job.html_context) {
        lines.push('```html');
        lines.push(job.html_context);
        lines.push('```');
      }
      lines.push('');
    }

    lines.push(`Task: ${job.pm_message}`);
    lines.push('');
    lines.push(
      'Apply the requested UI change to the codebase. ' +
      'Edit only the files needed. Do not break existing functionality. ' +
      'Do not commit — the agent will handle git operations.'
    );

    return lines.join('\n');
  }

  /**
   * Spawn the `claude` CLI with the given prompt.
   * Non-blocking — listen to events for progress.
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

    this.#proc = spawn('claude', args, {
      cwd:   this.#repoPath,
      env:   process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let resultText = '';

    this.#proc.stdout.setEncoding('utf8');
    this.#proc.stdout.on('data', (chunk) => {
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
      // Non-fatal: emit as info so the PM can see warnings
      const text = chunk.trim();
      if (text) this.emit('info', `[stderr] ${text}`);
    });

    this.#proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        this.emit('error', new Error(
          '`claude` command not found. ' +
          'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code'
        ));
      } else {
        this.emit('error', err);
      }
    });

    this.#proc.on('close', (code) => {
      if (code !== 0) {
        this.emit('error', new Error(`claude exited with code ${code}`));
      } else {
        this.emit('done', resultText);
      }
    });
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
