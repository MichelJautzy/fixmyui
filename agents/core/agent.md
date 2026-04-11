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
| `connect(installationId)` | Ouvre le WebSocket, écoute les événements `job`, `config-updated`, `connected`, `error`, `disconnected` |
| `syncRemoteConfig()` | Fetch `GET /api/fixmyui/agent/me` et merge les champs agent-relevant dans `#config` (env vars prioritaires) |
| `handleJob(payload)` | Pipeline complet : sync config → branch → Claude → commit → push → report |
| `#runClaude(jobId, prompt)` | Spawne ClaudeRunner, forward les events thinking/action/info vers le SaaS en temps réel |
| `disconnect()` | Kill le runner actif + déconnecte le WebSocket |

### Sync config distante (push + pull)

La config agent-relevant (`branchStrategy`, `autoPush`, `postCommands`, `previewUrlTemplate`, `promptRules`, `branchName`) est synchronisée depuis le SaaS. Le `.fixmyui.json` ne sert que d'identité locale.

**Précédence** : `env var > remote SaaS > .fixmyui.json > default`

- **Push** : l'event `config-updated` sur le WebSocket met à jour `#config` en temps réel via `applyRemoteConfig()` (module `src/remoteConfig.js`)
- **Pull** : `syncRemoteConfig()` est appelé au début de chaque `handleJob()` (fallback si le push a été manqué)
- **Startup** : `ensureReverbConfig()` fetch la config complète au démarrage

### Pipeline `handleJob()`

1. `syncRemoteConfig()` — fetch et merge la config distante
2. `git.assertIsRepo()` — vérifie que c'est un repo git
3. `git.checkoutBranch(branchName)` — crée la branche
4. `ClaudeRunner.buildPrompt()` — construit le prompt
5. `#runClaude()` — exécute Claude avec streaming
6. `git.isDirty()` → `git.addAll()` → `git.commit()` — commit si changements
7. `git.push()` — push si `autoPush`
8. `saas.complete()` — rapport de succès

En cas d'erreur : `saas.fail()` + `git.checkoutExisting(originalBranch)`

### Version reporting

`start.js` lit `pkg.version` depuis `package.json` et l'ajoute au config object (`config.agentVersion`). `ReverbClient` envoie cette version dans le body de chaque `broadcastAuth` (`agent_version`). Le SaaS la stocke dans `fixmyui_installations.agent_version` et l'utilise pour le version gate du widget (bannière + blocage si version < `FIXMYUI_MIN_NPM_VERSION`).

### Remontée d'erreurs au SaaS

L'agent remonte les erreurs non-job au SaaS via `saas.reportError(message)` (best-effort, ne crashe jamais) :

- **`start.js`** : erreurs post-config (ensureReverbConfig échoue, installationId manquant)
- **`Agent.js`** : WebSocket disconnected + WebSocket errors

Ces erreurs sont stockées dans `fixmyui_installations.last_agent_error` et affichées en bannière rouge dans le dashboard. Elles sont automatiquement effacées quand l'agent se reconnecte avec succès (`broadcastAuth`).

Les erreurs de config fatales (secret manquant) ne peuvent pas être remontées car l'agent ne peut pas s'authentifier.

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
- Élément DOM sélectionné (HTML + XPath)
- Screenshot de la zone ciblée (URL publique, si fourni par le PM via le widget)
- Message du PM
- Instructions : appliquer le changement, ne pas commit, ne pas casser l'existant

Si `screenshot_url` est présent, le prompt inclut l'URL avec une instruction demandant à Claude d'analyser l'image pour comprendre l'état visuel actuel de l'UI.

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
| `job` | `object` | Nouveau job reçu (`{ job_id, message, page_url, html_context, element_xpath, screenshot_url, history }`) |
| `config-updated` | `object` | Config agent-relevant modifiée depuis le dashboard |
| `connected` | — | Connexion WebSocket établie |
| `disconnected` | — | Déconnexion WebSocket |
| `error` | `Error` | Erreur connexion ou souscription |

### Connexion

1. Charge le constructeur depuis `pusher-js/node.js` en gérant l’interop CJS/ESM (`default` vs export direct — évite `Pusher is not a constructor` sur certains Node).
2. Instancie `Pusher` avec la `reverbAppKey`
3. Configure l'auth du canal privé via `customHandler` → `POST /api/fixmyui/agent/broadcasting/auth` (envoie `agent_version` dans le body)
4. Souscrit au canal `private-fixmyui.agent.{installationId}`
5. Écoute les événements `new-job` et `config-updated` broadcastés par le SaaS

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
