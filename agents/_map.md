# Map de la Documentation — agents/

> Index vivant. Mis à jour automatiquement par l'agent à chaque ajout ou suppression de fichier dans ce dossier.
> Pour démarrer une session : lire `_truth.md` → ce fichier → fichiers pertinents à la tâche.

---

## Fichiers Racine

| Fichier | Rôle | Priorité |
|---------|------|----------|
| [`_truth.md`](_truth.md) | Vision produit, règles architecturales intangibles, entité légale. **NON MODIFIABLE.** | Toujours lire en premier |
| [`_map.md`](_map.md) | Ce fichier — index de toute la documentation | Lire en deuxième |
| [`_instructions.md`](_instructions.md) | Règles d'auto-update : quoi lire selon la tâche, quand mettre à jour la doc | Lire si tu modifies ou crées de la doc |

---

## Architecture

| Fichier | Contenu | Lire quand |
|---------|---------|------------|
| [`architecture/overview.md`](architecture/overview.md) | Structure du projet, flux de données, cycle de vie d'un job, configuration | Toute tâche architecturale, nouveau module, refactoring |

---

## Core — Modules Agent

| Fichier | Contenu | Lire quand |
|---------|---------|------------|
| [`core/agent.md`](core/agent.md) | Agent principal, ClaudeRunner, ReverbClient, GitHelper — orchestration du pipeline | Tâches sur le cycle de vie des jobs, WebSocket, Claude, git |

---

## CLI — Commandes

| Fichier | Contenu | Lire quand |
|---------|---------|------------|
| [`cli/commands.md`](cli/commands.md) | Commandes CLI (init, start, test, status), entry point `bin/fixmyui.js` | Ajout/modification de commandes CLI, UX terminal |

---

## Intégrations

| Fichier | Contenu | Lire quand |
|---------|---------|------------|
| [`integrations/saas-api.md`](integrations/saas-api.md) | SaasClient : endpoints HTTP, authentification, reporting de progression | Tâches API, communication avec fixmyui.com, endpoints |
