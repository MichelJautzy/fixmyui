# CLI — Commandes

> Entry point : `bin/fixmyui.js` — utilise Commander pour le parsing.

---

## Vue d'ensemble

```bash
fixmyui init      # Wizard interactif → crée .fixmyui.json
fixmyui reset     # Supprime .fixmyui.json — puis relancer init
fixmyui start     # Démarre le daemon agent (bloque jusqu'à Ctrl+C)
fixmyui test      # Vérifie config, connectivité SaaS, Claude CLI, git
fixmyui status    # Affiche la config courante (secret masqué)
```

Si aucune commande n'est passée, affiche l'aide automatiquement.

---

## `fixmyui init`

**Fichier :** `src/commands/init.js`

Wizard interactif qui :
1. Demande l'`agentSecret` (fourni dans le dashboard fixmyui.com)
2. Appelle `SaasClient.me()` pour valider le secret et récupérer l'`installationId`
3. Récupère la config Reverb depuis le SaaS (`ensureReverbConfig.js`)
4. Demande les options optionnelles (repoPath, branchPrefix, autoPush, previewUrlTemplate)
5. Écrit `.fixmyui.json` via `writeConfig()`

Utilise `@inquirer/prompts` pour les prompts interactifs.

---

## `fixmyui reset`

**Fichier :** `src/commands/reset.js`

Supprime le fichier `.fixmyui.json` dans le répertoire courant (`process.cwd()`). Si le fichier est absent, affiche un message et suggère quand même `fixmyui init`.

Ne modifie pas `.env` ni les variables d’environnement : après un reset, `FIXMYUI_*` peuvent encore surcharger ou fournir des valeurs tant que `init` n’a pas été relancé.

---

## `fixmyui start`

**Fichier :** `src/commands/start.js`

1. Charge et valide la config (`loadConfig()` + `validateConfig()`)
2. S'assure que `reverbAppKey` est disponible (fetch depuis le SaaS si absent)
3. Instancie `Agent` et appelle `agent.connect(installationId)`
4. Gère le graceful shutdown sur `SIGINT` / `SIGTERM` → `agent.disconnect()`

Le processus bloque indéfiniment (daemon). Pour le rendre persistant : `pm2 start $(which fixmyui) --name fixmyui -- start`.

---

## `fixmyui test`

**Fichier :** `src/commands/test.js`

Exécute une série de vérifications :
1. **Config** — `.fixmyui.json` trouvé et parsable
2. **Authentification** — `SaasClient.ping()` valide le secret
3. **Claude CLI** — `claude --version` fonctionne
4. **Git** — le `repoPath` est un repo git valide

Affiche un rapport coloré (chalk) avec le statut de chaque vérification.

---

## `fixmyui status`

**Fichier :** directement dans `bin/fixmyui.js`

Affiche la configuration courante avec le secret masqué (`fmui_sk_xxxx••••••••`). Utile pour debug rapide.

---

## Ajouter une nouvelle commande

1. Créer `src/commands/{nom}.js` avec une fonction exportée `run{Nom}()`
2. Enregistrer la commande dans `bin/fixmyui.js` via `program.command('{nom}')`
3. Mettre à jour ce fichier (`cli/commands.md`)
4. Mettre à jour `_map.md` si la nouvelle commande justifie un fichier doc séparé
