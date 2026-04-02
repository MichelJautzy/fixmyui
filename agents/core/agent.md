# Core — Agent, ClaudeRunner, ReverbClient, GitHelper

> Tous les fichiers vivent dans `src/agent/`. C'est le cœur du pipeline de traitement des jobs.

---

## Agent (`Agent.js`)

Orchestrateur principal. Relie toutes les pièces : WebSocket → Claude → Git → API.

### Propriétés privées

| Propriété | Type | Description |
|-----------|------|-------------|
| `#config` | `Config` | Configuration chargée |
| `#saas` | `SaasClient` | Client HTTP pour le SaaS |
| `#reverb` | `ReverbClient` | Client WebSocket |
| `#git` | `GitHelper` | Opérations git |
| `#originalBranch` | `string\|null` | Branche avant le job (pour restauration) |
| `#activeRunner` | `ClaudeRunner\|null` | Runner en cours (pour kill graceful) |

### Méthodes

| Méthode | Description |
|---------|-------------|
| `constructor(config, { log })` | Instancie SaasClient et GitHelper |
| `connect(installationId)` | Ouvre le WebSocket, écoute les événements `job`, `connected`, `error`, `disconnected` |
| `handleJob(payload)` | Pipeline complet : branch → Claude → commit → push → report |
| `#runClaude(jobId, prompt)` | Spawne ClaudeRunner, forward les events thinking/action/info vers le SaaS en temps réel |
| `disconnect()` | Kill le runner actif + déconnecte le WebSocket |

### Pipeline `handleJob()`

1. `git.assertIsRepo()` — vérifie que c'est un repo git
2. `git.checkoutBranch(branchName)` — crée la branche
3. `ClaudeRunner.buildPrompt()` — construit le prompt
4. `#runClaude()` — exécute Claude avec streaming
5. `git.isDirty()` → `git.addAll()` → `git.commit()` — commit si changements
6. `git.push()` — push si `autoPush`
7. `saas.complete()` — rapport de succès

En cas d'erreur : `saas.fail()` + `git.checkoutExisting(originalBranch)`

---

## ClaudeRunner (`ClaudeRunner.js`)

Spawne le CLI `claude` en subprocess et parse le flux `stream-json`.

### Événements émis

| Événement | Payload | Description |
|-----------|---------|-------------|
| `thinking` | `string` | Claude raisonne (thinking blocks) |
| `action` | `string` | Claude utilise un outil (édition, bash, lecture) |
| `info` | `string` | Texte informatif (text blocks, stderr) |
| `result` | `string` | Résultat final de Claude |
| `error` | `Error` | Erreur process (ENOENT, exit code != 0) |
| `done` | `string` | Process terminé proprement (avec le resultText) |

### `buildPrompt(job)` (statique)

Construit le prompt envoyé à Claude à partir du job :
- Historique des turns précédents (si conversation multi-tour)
- URL de la page concernée
- Message du PM
- Instructions : appliquer le changement, ne pas commit, ne pas casser l'existant

### `run(prompt)`

Commande spawned :
```
claude -p "<prompt>" --output-format stream-json --verbose --permission-mode acceptEdits
```

Le parsing stream-json gère les types d'événements :
- `assistant` → content blocks (thinking, tool_use, text)
- `result` → résultat final
- `system` → ignoré

### Modes de permission Claude

| Mode | Description |
|------|-------------|
| `acceptEdits` | Auto-approve les éditions fichiers (défaut, recommandé staging) |
| `bypassPermissions` | Sandbox complet, le plus permissif |
| `default` | Demande approbation (bloquant sans TTY) |
| `dontAsk` | Ne demande pas mais refuse silencieusement |
| `plan` | Mode planification uniquement |
| `auto` | Mode automatique |

---

## ReverbClient (`ReverbClient.js`)

Client WebSocket basé sur `pusher-js` pour communiquer avec Laravel Reverb.

### Événements émis

| Événement | Payload | Description |
|-----------|---------|-------------|
| `job` | `object` | Nouveau job reçu (`{ job_id, message, page_url, history }`) |
| `connected` | — | Connexion WebSocket établie |
| `disconnected` | — | Déconnexion WebSocket |
| `error` | `Error` | Erreur connexion ou souscription |

### Connexion

1. Instancie `Pusher` avec la `reverbAppKey`
2. Configure l'auth du canal privé via `customHandler` → `POST /api/fixmyui/agent/broadcasting/auth`
3. Souscrit au canal `private-fixmyui.agent.{installationId}`
4. Écoute l'événement `new-job` broadcasté par le SaaS

### Paramètres WebSocket

- **Host** : hostname de `apiUrl` (ou override `reverbHost`)
- **Port** : 443 si TLS, 8080 sinon (ou override `reverbPort`)
- **TLS** : auto-détecté depuis le protocole de `apiUrl`
- **Transports** : `ws` et `wss` uniquement (pas de fallback long-polling)

---

## GitHelper (`GitHelper.js`)

Wrapper autour de `simple-git` pour les opérations git du pipeline.

### Méthodes

| Méthode | Description |
|---------|-------------|
| `assertIsRepo()` | Vérifie que `repoPath` est un repo git |
| `checkoutBranch(name)` | Crée une nouvelle branche locale et checkout |
| `addAll()` | `git add .` |
| `commit(message)` | Commit et retourne le hash court |
| `push(branchName)` | Push vers origin avec `--set-upstream` |
| `isDirty()` | `true` si le working tree a des changements |
| `currentBranch()` | Retourne le nom de la branche courante |
| `checkoutExisting(branch)` | Checkout une branche existante (restauration) |

### Contraintes

- `maxConcurrentProcesses: 1` — pas d'opérations git parallèles
- Jamais de merge, rebase ou force push
- Toutes les opérations dans `repoPath`
