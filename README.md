# fixmyui

The FixMyUI agent runs on your staging server. It listens for PM feedback jobs from [fixmyui.com](https://fixmyui.com), spawns Claude Code to apply the changes, and reports progress back in real time.

---

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude --version`)
- Git configured on the server
- A FixMyUI account with an installation created at [fixmyui.com/fixmyui](https://fixmyui.com/fixmyui)

---

## Install

```bash
npm install -g fixmyui
```

---

## Quick start

Run these commands in the **root of your project** on the staging server:

```bash
# 1. Interactive setup — creates .fixmyui.json
fixmyui init

# 2. Test the connection to FixMyUI SaaS + Reverb
fixmyui test

# 3. Start the agent daemon
fixmyui start
```

To keep it running permanently, use pm2:

```bash
npm install -g pm2
pm2 start fixmyui --name fixmyui -- start --config /path/to/.fixmyui.json
pm2 save
pm2 startup
```

The `-- start` passes the `start` subcommand to fixmyui (everything after `--` goes to the script, not PM2). The `--config` flag tells the agent exactly where to find the config file, avoiding cwd-related issues.

---

## Configuration

`fixmyui init` creates a `.fixmyui.json` file in the current directory. You can also use environment variables (which take priority):

| `.fixmyui.json` key | Env var | Default | Description |
|---|---|---|---|
| `apiUrl` | `FIXMYUI_API_URL` | `https://fixmyui.com` | FixMyUI SaaS URL |
| `agentSecret` | `FIXMYUI_AGENT_SECRET` | — | Secret from the dashboard (required) |
| `repoPath` | — | cwd | Absolute path to the git repository root |
| `branchPrefix` | `FIXMYUI_BRANCH_PREFIX` | `fixmyui` | Git branch prefix per job |
| `autoPush` | `FIXMYUI_AUTO_PUSH` | `true` | Push branch after commit |
| `previewUrlTemplate` | `FIXMYUI_PREVIEW_URL_TEMPLATE` | — | e.g. `https://staging.myapp.com?branch={branch}` |
| `claudePermissionMode` | `FIXMYUI_CLAUDE_PERMISSION_MODE` | `acceptEdits` | Headless: auto-approve file edits (see Security) |

**Global CLI option:** `--config <path>` (or `-c`) — explicit path to `.fixmyui.json`, works with all commands. Useful when the config file is not in the current directory (PM2, cron, systemd, Docker).

`fixmyui init` writes `repoPath` as an absolute path so the agent works regardless of the working directory.

---

## Commands

```bash
fixmyui init                    # Interactive setup wizard
fixmyui start                   # Start the agent daemon (blocks until Ctrl+C)
fixmyui test                    # Check config, connectivity, and Claude availability
fixmyui status                  # Show current config (masks the secret)
fixmyui start -c /path/to/.fixmyui.json   # Use a specific config file
```

---

## How it works

```
fixmyui start
  └─ connects to Reverb WebSocket at fixmyui.com
  └─ subscribes to private-fixmyui.agent.{installationId}

PM sends message on staging site
  └─ SaaS broadcasts "new-job" event to agent

Agent receives job
  └─ git checkout -b fixmyui/{job_id}
  └─ spawns: claude -p "<task>" --output-format stream-json
  └─ streams progress → SaaS → PM widget (real time)
  └─ git add -A && git commit -m "fixmyui: <pm_message>"
  └─ git push origin fixmyui/{job_id}
  └─ reports complete with branch + preview URL
```

---

## Security

- The `agentSecret` (`fmui_sk_xxx`) is stored only on your server. The SaaS stores only its `sha256` hash.
- The WebSocket channel is private — authenticated per session with an HMAC signature.
- Add `.fixmyui.json` to your `.gitignore` (or use env vars) to avoid committing the secret.
- **Claude permission mode:** the agent runs with `--permission-mode acceptEdits` by default so Claude Code can write files **without a human at the terminal**. Use only on **trusted** staging/build hosts. For stricter control use `default` or `plan` (Claude may stall waiting for approval). `bypassPermissions` is the most permissive — sandbox only.

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `claude: command not found` | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and ensure it's in `$PATH` |
| `Unauthorized` on connect | Check your `agentSecret` matches the one in the FixMyUI dashboard |
| Jobs not received | Run `fixmyui test` to verify WebSocket connectivity |
| Push fails | Ensure the server has push access to the repo (`git push` manually) |
| "approve file edit permission" / edits not applied | Normal in default Claude mode without a TTY. The agent uses `acceptEdits` by default; set `FIXMYUI_CLAUDE_PERMISSION_MODE=acceptEdits` or add `"claudePermissionMode": "acceptEdits"` to `.fixmyui.json` |
| `Missing agentSecret` with PM2 | PM2 may use a different working directory. Use `--config`: `pm2 start fixmyui -- start --config /var/www/.fixmyui.json`. Don't forget `-- start` (double dash) to pass args to fixmyui. |
