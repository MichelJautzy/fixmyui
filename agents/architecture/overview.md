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
│   ├── Config.js               # Chargement config locale (.fixmyui.json + env)
│   ├── SaasClient.js           # Client HTTP pour l'API FixMyUI
│   ├── remoteConfig.js         # applyRemoteConfig() — merge config SaaS dans l'objet en mémoire
│   └── ensureReverbConfig.js   # Fetch Reverb + config remote au démarrage
├── package.json
├── .env.example
├── .gitignore
├── CONTEXT.md                  # Pointe vers agents/
└── agents/                     # Documentation IA
```

Le package npm public visé est `fixmyui`, avec un binaire global également nommé `fixmyui`.

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
  ├─ 2. récupère payload.compiled_prompt (déjà compilé côté SaaS par FixmyuiPromptBuilder)
  │
  ├─ 3. spawn claude -p "<compiled_prompt>" --output-format stream-json --permission-mode acceptEdits [--model <slug>]
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

### Fichier `.fixmyui.json` — identité locale uniquement

`fixmyui init` ne crée que les champs d'identité et de connexion. Les paramètres « métier » (stratégie de branche, auto-push, prompt rules…) sont gérés sur le dashboard SaaS et synchronisés automatiquement.

| Clé | Env var | Défaut | Description |
|-----|---------|--------|-------------|
| `apiUrl` | `FIXMYUI_API_URL` | `https://fixmyui.com` | URL du SaaS |
| `agentSecret` | `FIXMYUI_AGENT_SECRET` | — | Secret agent (requis) |
| `installationId` | `FIXMYUI_INSTALLATION_ID` | — | ID installation (résolu via `init`) |
| `repoPath` | — | cwd | Chemin absolu vers la racine du repo git |
| `claudePermissionMode` | `FIXMYUI_CLAUDE_PERMISSION_MODE` | `acceptEdits` | Mode permission Claude Code |
| `reverbAppKey` | `FIXMYUI_REVERB_APP_KEY` | — | Clé publique Reverb (set par `init`) |
| `reverbHost` | `FIXMYUI_REVERB_HOST` | hostname de `apiUrl` | Host WebSocket |
| `reverbPort` | `FIXMYUI_REVERB_PORT` | 443 (TLS) / 8080 | Port WebSocket |
| `reverbScheme` | `FIXMYUI_REVERB_SCHEME` | auto depuis `apiUrl` | `http` ou `https` |

### Config remote (SaaS = source de vérité)

Ces champs ne sont **pas** dans `.fixmyui.json`. Ils sont récupérés du SaaS au démarrage (`ensureReverbConfig`), avant chaque job (`syncRemoteConfig`), et en temps réel via WebSocket (`config-updated`). Des env vars peuvent les surcharger :

| Paramètre | Env var override |
|-----------|-----------------|
| `branchStrategy` | `FIXMYUI_BRANCH_STRATEGY` |
| `branchPrefix` | `FIXMYUI_BRANCH_PREFIX` |
| `branchName` | `FIXMYUI_BRANCH_NAME` |
| `autoPush` | `FIXMYUI_AUTO_PUSH` |
| `postCommands` | — |
| `previewUrlTemplate` | `FIXMYUI_PREVIEW_URL_TEMPLATE` |

> `prompt_rules`, `ai_policies`, `global_context` ne sont plus synchronisés côté agent : depuis 2.0.0, le prompt Claude complet (`compiled_prompt`) est construit côté SaaS et envoyé dans le payload `new-job`.

### Flag global `--config`

Toutes les commandes acceptent `-c, --config <path>` pour spécifier le chemin exact vers `.fixmyui.json`. Sans ce flag, le fichier est cherché dans `process.cwd()`.

`repoPath` est résolu relativement au répertoire du fichier de config (pas au cwd), ce qui rend les chemins relatifs fiables même avec `--config`. `fixmyui init` écrit `repoPath` en absolu par défaut.

Exemple PM2 :
```bash
pm2 start fixmyui --name fixmyui -- start --config /var/www/.fixmyui.json
```

### Priorité de chargement

1. Variables d'environnement (prioritaires)
2. SaaS remote config (via API / WebSocket)
3. Valeurs par défaut

`loadConfig()` dans `Config.js` charge `.env` + `.fixmyui.json` pour l'identité locale. `ensureReverbConfig()` puis `applyRemoteConfig()` complètent les champs métier depuis le SaaS.

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
