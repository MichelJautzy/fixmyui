# Instructions pour les Agents IA

> Ce fichier définit comment maintenir la documentation à jour et quel contexte charger selon la tâche. À lire avant de modifier quoi que ce soit dans `agents/`.

---

## Règle fondamentale

```
_truth.md   → JAMAIS modifier
_map.md     → Mettre à jour si fichier ajouté ou supprimé dans agents/
Tout le reste → Mettre à jour quand le code correspondant change
```

---

## Quoi lire selon la tâche

| Type de tâche | Fichiers à charger |
|---------------|-------------------|
| Tout type (base) | `_truth.md` + `_map.md` |
| Architecture / refactoring | + `architecture/overview.md` |
| Agent core / pipeline jobs | + `core/agent.md` |
| WebSocket / Reverb | + `core/agent.md` (section ReverbClient) |
| Claude Code / spawn | + `core/agent.md` (section ClaudeRunner) |
| Git operations | + `core/agent.md` (section GitHelper) |
| Commandes CLI | + `cli/commands.md` |
| API SaaS / endpoints | + `integrations/saas-api.md` |
| Configuration | + `architecture/overview.md` (section Config) |

---

## Quand mettre à jour la doc

### Règles de mise à jour obligatoire

1. **Tu modifies `Agent.js` (orchestration, lifecycle, events)**
   → Mettre à jour `core/agent.md`

2. **Tu modifies `ClaudeRunner.js` (spawn, stream-json parsing, prompt building)**
   → Mettre à jour `core/agent.md` (section ClaudeRunner)

3. **Tu modifies `ReverbClient.js` (WebSocket, auth, événements)**
   → Mettre à jour `core/agent.md` (section ReverbClient)

4. **Tu modifies `GitHelper.js` (branch, commit, push)**
   → Mettre à jour `core/agent.md` (section GitHelper)

5. **Tu modifies `SaasClient.js` (endpoints HTTP, auth)**
   → Mettre à jour `integrations/saas-api.md`

6. **Tu modifies `Config.js` (nouvelles options, validation)**
   → Mettre à jour `architecture/overview.md` (section Configuration)

7. **Tu ajoutes ou modifies une commande CLI (`src/commands/` ou `bin/fixmyui.js`)**
   → Mettre à jour `cli/commands.md`

8. **Tu ajoutes une dépendance npm ou changes la structure du projet**
   → Mettre à jour `architecture/overview.md`

9. **Tu crées ou supprimes un fichier dans `agents/`**
   → Mettre à jour `_map.md`

---

## Ce qui ne change jamais

- `_truth.md` — vision produit, règles architecturales, entité légale, stack
- Le principe agent-side uniquement (pas de logique serveur)
- La communication temps réel via Reverb/Pusher
- L'isolation par branches git
- Le mode headless de Claude Code

---

## Interdictions

- Ne jamais créer de fichier `.md` dans le projet sans demande explicite de l'utilisateur
- Ne jamais créer de script `.sh` sans autorisation explicite
- Ne jamais modifier `_truth.md`
- Ne jamais mettre de logique métier dans les fichiers de documentation
