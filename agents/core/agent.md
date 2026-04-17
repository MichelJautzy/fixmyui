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

La config agent-relevant (`branchStrategy`, `autoPush`, `postCommands`, `previewUrlTemplate`, `branchName`) est synchronisée depuis le SaaS. Le `.fixmyui.json` ne sert que d'identité locale.

> Depuis fixmyui 2.0.0, la construction du prompt Claude (règles admin, politiques fichiers, contexte global, historique, contexte DOM, screenshot, message PM) est faite côté SaaS via `App\Modules\Fixmyui\Services\FixmyuiPromptBuilder`. L'agent reçoit directement `compiled_prompt` dans le payload `new-job` et le passe tel quel à `claude -p`. Les anciens champs `promptRules` / `aiPolicies` / `globalContext` ne sont plus synchronisés.

**Précédence** : `env var > remote SaaS > .fixmyui.json > default`

- **Push** : l'event `config-updated` sur le WebSocket met à jour `#config` en temps réel via `applyRemoteConfig()` (module `src/remoteConfig.js`)
- **Pull** : `syncRemoteConfig()` est appelé au début de chaque `handleJob()` (fallback si le push a été manqué)
- **Startup** : `ensureReverbConfig()` fetch la config complète au démarrage

### Pipeline `handleJob()`

1. `syncRemoteConfig()` — fetch et merge la config distante (git / postCommands seulement)
2. `git.assertIsRepo()` — vérifie que c'est un repo git
3. `git.checkoutBranch(branchName)` — crée la branche
4. Récupère `payload.compiled_prompt` (construit par le SaaS) — aucun build local
5. **Attachment prefetch** (fixmyui ≥ 2.0.2, voir section dédiée) — normalise `attachments[]` (fallback `screenshot_url` unique pour SaaS < 2026-04-16), download de toutes les images dans `.fixmyui-tmp/` en parallèle, rewrite de chaque URL en chemin local dans le prompt
6. `#runClaude(jobId, compiled_prompt)` — exécute Claude avec streaming
7. `git.isDirty()` → `git.addAll()` → `git.commit()` — commit si changements
8. `git.push()` — push si `autoPush`
9. `saas.complete()` — rapport de succès
10. `finally` : cleanup de chaque image téléchargée (unlink + rmdir `.fixmyui-tmp/` si vide)

En cas d'erreur : `saas.fail()` + `git.checkoutExisting(originalBranch)` (le cleanup des attachments est toujours exécuté).

### Attachment prefetch (`ScreenshotPrefetcher.js`, fixmyui ≥ 2.0.2)

Le SaaS injecte les URLs publiques des images (bucket R2/S3) directement dans `compiled_prompt` — une capture live prise par le widget, ou plusieurs images si le user a utilisé le bouton upload / le drag-and-drop (jusqu'à 10 par message). En `claude -p` sans TTY, Claude Code peut refuser de fetch le réseau (même en `acceptEdits`) car il n'a personne pour accorder la permission.

Solution auto-portante : l'agent **télécharge lui-même chaque image** avant de spawn Claude, puis remplace chaque URL par un chemin local. Claude utilise ensuite son outil `Read` (qui supporte nativement PNG/JPG/WebP/GIF) — aucune permission réseau requise.

- **Répertoire** : `<repoPath>/.fixmyui-tmp/screenshot-<jobId>-<NN>.<ext>` (index zéro-paddé `00`, `01`, …)
- **Git** : la ligne `.fixmyui-tmp/` est ajoutée à `.git/info/exclude` au premier job (exclusion **locale**, jamais committée). `git add -A` ne la voit pas.
- **Parallélisme** : `Promise.all` sur tout le batch — une image qui échoue n'abort pas les autres.
- **Garde-fous par image** : timeout 15 s, cap 20 Mo, vérification `content-type: image/*`, UUID-safe filename, cleanup dans `finally`.
- **Fallback** : les images non téléchargées (404, DNS, timeout…) restent en URL dans le prompt et un warning est loggé. Claude retentera alors un `WebFetch` — cf. section permissions ci-dessous pour débloquer.
- **Compat** : si le SaaS est antérieur au 2026-04-16 (`attachments` absent du payload), l'agent retombe sur `screenshot_url` et se comporte comme 2.0.1.

API (module `src/agent/ScreenshotPrefetcher.js`) :
- `prefetchScreenshot(url, { repoPath, jobId, index })` → `{ localPath, cleanup }`
- `prefetchAttachments(list, { repoPath, jobId, onError })` → `Array<{ url, localPath, cleanup }>` (seulement les succès)
- `rewritePromptWithLocalScreenshot(prompt, url, localPath)` — une URL
- `rewritePromptWithLocalScreenshots(prompt, prefetched)` — batch

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

### Prompt (construit côté SaaS)

Depuis fixmyui 2.0.0, la méthode statique `buildPrompt` n'existe plus dans ce fichier. Le prompt envoyé à `claude -p` est compilé par le SaaS (`App\Modules\Fixmyui\Services\FixmyuiPromptBuilder`) et livré dans le payload `new-job` sous la clé `compiled_prompt`. L'agent se contente de le passer tel quel à `run(prompt)`.

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
| `acceptEdits` | Auto-approve les éditions fichiers (défaut). **Ne couvre pas** systématiquement les outils réseau (`WebFetch` pour l’URL du screenshot dans le prompt) — en `-p` sans TTY, Claude peut dire qu’il manque la permission pour télécharger l’image. |
| `auto` | Auto-approve les appels d’outils avec garde-fous (souvent adapté si le prompt contient une URL screenshot à fetch). |
| `bypassPermissions` | Le plus permissif — réservé à un runner isolé / CI. |
| `default` | Demande approbation (bloquant sans TTY) |
| `dontAsk` | Ne demande pas mais refuse silencieusement |
| `plan` | Mode planification uniquement |

Alternative sans changer le mode : règles `permissions` / hooks dans `.claude/settings.json` du repo ou du home pour autoriser `WebFetch` vers le domaine public R2 / CDN (voir doc Anthropic « Configure permissions »).

---

## ReverbClient (`ReverbClient.js`)

Client WebSocket basé sur `pusher-js` pour communiquer avec Laravel Reverb.

### Événements émis

| Événement | Payload | Description |
|-----------|---------|-------------|
| `job` | `object` | Nouveau job reçu (`{ job_id, message, page_url, screenshot_url, attachments, compiled_prompt }`) |
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
