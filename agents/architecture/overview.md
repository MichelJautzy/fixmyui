# Architecture — FixMyUI Agent

---

## Structure du Projet

```
fixmyui/
├── bin/
│   └── fixmyui.js              # Entry point CLI (Commander)
├── src/
│   ├── agent/
│   │   ├── Agent.js            # Orchestrateur principal — lifecycle des jobs
│   │   ├── ClaudeRunner.js     # Spawn claude CLI, parse stream-json
│   │   ├── ReverbClient.js     # WebSocket Pusher/Reverb — réception des jobs
│   │   └── GitHelper.js        # Opérations git (simple-git)
│   ├── commands/
│   │   ├── init.js             # Wizard interactif — crée .fixmyui.json
│   │   ├── start.js            # Démarre le daemon agent
│   │   └── test.js             # Tests connectivité, Claude, git
│   ├── Config.js               # Chargement config (.fixmyui.json + env)
│   ├── SaasClient.js           # Client HTTP pour l'API FixMyUI
│   └── ensureReverbConfig.js   # Récupère reverbAppKey depuis le SaaS si absent
├── package.json
├── .env.example
├── .gitignore
├── CONTEXT.md                  # Pointe vers agents/
└── agents/                     # Documentation IA
```

---

## Flux de Données — Cycle de Vie d'un Job

```
PM envoie message via widget fixmyui.com
  │
  ▼
SaaS (Laravel) crée un Job en DB
  │
  ▼
SaaS broadcast "new-job" via Reverb WebSocket
  │
  ▼
Agent reçoit le job sur private-fixmyui.agent.{installationId}
  │
  ├─ 1. git checkout -b {prefix}/{job_id_short}
  │
  ├─ 2. ClaudeRunner.buildPrompt() → construit le prompt avec contexte + historique
  │
  ├─ 3. spawn claude -p "<prompt>" --output-format stream-json --permission-mode acceptEdits
  │     │
  │     ├─ thinking → POST /agent/jobs/{id}/progress (type: thinking)
  │     ├─ action  → POST /agent/jobs/{id}/progress (type: action)
  │     └─ result  → stocké pour le rapport final
  │
  ├─ 4. git add -A && git commit -m "fixmyui: <message>"
  │
  ├─ 5. git push origin {branch} (si autoPush)
  │
  └─ 6. POST /agent/jobs/{id}/complete { branch, preview_url, result_message }
```

En cas d'erreur à n'importe quelle étape :
- `POST /agent/jobs/{id}/fail` avec le message d'erreur
- Retour à la branche originale

---

## Configuration

### Fichier `.fixmyui.json` (créé par `fixmyui init`)

| Clé | Env var | Défaut | Description |
|-----|---------|--------|-------------|
| `apiUrl` | `FIXMYUI_API_URL` | `https://fixmyui.com` | URL du SaaS |
| `agentSecret` | `FIXMYUI_AGENT_SECRET` | — | Secret agent (requis) |
| `installationId` | `FIXMYUI_INSTALLATION_ID` | — | ID installation (résolu via `init`) |
| `repoPath` | — | `.` | Chemin vers la racine du repo git |
| `branchPrefix` | `FIXMYUI_BRANCH_PREFIX` | `fixmyui` | Préfixe des branches créées |
| `autoPush` | `FIXMYUI_AUTO_PUSH` | `true` | Push automatique après commit |
| `previewUrlTemplate` | `FIXMYUI_PREVIEW_URL_TEMPLATE` | — | Template URL preview (`{branch}` remplacé) |
| `claudePermissionMode` | `FIXMYUI_CLAUDE_PERMISSION_MODE` | `acceptEdits` | Mode permission Claude Code |
| `reverbAppKey` | `FIXMYUI_REVERB_APP_KEY` | — | Clé publique Reverb (auto-fetch si absent) |
| `reverbHost` | `FIXMYUI_REVERB_HOST` | hostname de `apiUrl` | Host WebSocket |
| `reverbPort` | `FIXMYUI_REVERB_PORT` | 443 (TLS) / 8080 | Port WebSocket |
| `reverbScheme` | `FIXMYUI_REVERB_SCHEME` | auto depuis `apiUrl` | `http` ou `https` |

### Priorité de chargement

1. Variables d'environnement (prioritaires)
2. `.fixmyui.json` dans le répertoire courant
3. Valeurs par défaut

La fonction `loadConfig()` dans `Config.js` charge `.env` via dotenv, puis `.fixmyui.json`, avec les env vars en override.

---

## Dépendances

| Package | Version | Rôle |
|---------|---------|------|
| `commander` | ^13.1.0 | Parsing des commandes CLI |
| `pusher-js` | ^8.4.0 | Client WebSocket Reverb |
| `simple-git` | ^3.27.0 | Opérations git programmatiques |
| `dotenv` | ^16.4.7 | Chargement `.env` |
| `chalk` | ^5.4.1 | Couleurs terminal |
| `ora` | ^8.2.0 | Spinners terminal |
| `@inquirer/prompts` | ^7.4.1 | Prompts interactifs (`fixmyui init`) |

---

## Relation avec le Repo SaaS

Ce repo est **exclusivement le client agent**. Le backend FixMyUI vit dans le repo `saas` :

| Composant | Emplacement |
|-----------|-------------|
| Module Laravel FixMyUI | `saas/app/Modules/FixMyUI/` |
| Widget JS (PM) | `saas` — template JS servi par le SaaS |
| Reverb server | `saas` — Laravel Reverb |
| API agent endpoints | `saas` — routes dans le module FixMyUI |
| Ce repo (agent CLI) | Package npm indépendant |

La documentation du côté SaaS se trouve dans `saas/agents/saas/fixmyui/overview.md`.
