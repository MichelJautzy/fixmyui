# fixmyui-agent

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
npm install -g fixmyui-agent
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
pm2 start $(which fixmyui) --name fixmyui-agent -- start
pm2 save
pm2 startup
```

---

## Configuration

`fixmyui init` creates a `.fixmyui.json` file in the current directory. You can also use environment variables (which take priority):

| `.fixmyui.json` key | Env var | Default | Description |
|---|---|---|---|
| `apiUrl` | `FIXMYUI_API_URL` | `https://fixmyui.com` | FixMyUI SaaS URL |
| `agentSecret` | `FIXMYUI_AGENT_SECRET` | — | Secret from the dashboard (required) |
| `repoPath` | — | `.` | Path to the git repository root |
| `branchPrefix` | `FIXMYUI_BRANCH_PREFIX` | `fixmyui` | Git branch prefix per job |
| `autoPush` | `FIXMYUI_AUTO_PUSH` | `true` | Push branch after commit |
| `previewUrlTemplate` | `FIXMYUI_PREVIEW_URL_TEMPLATE` | — | e.g. `https://staging.myapp.com?branch={branch}` |

---

## Commands

```bash
fixmyui init      # Interactive setup wizard
fixmyui start     # Start the agent daemon (blocks until Ctrl+C)
fixmyui test      # Check config, connectivity, and Claude availability
fixmyui status    # Show current config (masks the secret)
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

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `claude: command not found` | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and ensure it's in `$PATH` |
| `Unauthorized` on connect | Check your `agentSecret` matches the one in the FixMyUI dashboard |
| Jobs not received | Run `fixmyui test` to verify WebSocket connectivity |
| Push fails | Ensure the server has push access to the repo (`git push` manually) |
