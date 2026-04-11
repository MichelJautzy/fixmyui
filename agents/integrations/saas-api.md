# Intégration — SaasClient (API fixmyui.com)

> Fichier source : `src/SaasClient.js`

---

## Authentification

Toutes les requêtes utilisent le header :
```
Authorization: Bearer {agentSecret}
```

L'`agentSecret` est un token `fmui_sk_xxx` généré dans le dashboard fixmyui.com. Le SaaS valide le sha256 du secret contre celui stocké pour l'installation.

---

## Endpoints

### `GET /api/fixmyui/agent/me`

**Méthode :** `SaasClient.me()`

Retourne l'identité de l'installation associée au secret.

**Réponse :**
```json
{
  "installation_id": 42,
  "name": "My Staging",
  "allowed_origin": "https://staging.myapp.com",
  "is_active": true
}
```

Utilisé par `fixmyui init` pour résoudre l'`installationId` et valider le secret.

---

### `POST /api/fixmyui/agent/broadcasting/auth`

**Méthode :** Appelé par `ReverbClient` (customHandler dans `channelAuthorization`)

Authentifie la souscription à un canal privé Pusher/Reverb.

**Body :**
```json
{
  "socket_id": "123456.789",
  "channel_name": "private-fixmyui.agent.42"
}
```

**Réponse :** token d'auth Pusher (HMAC).

Aussi utilisé par `SaasClient.ping()` pour vérifier les credentials (test mode).

---

### `POST /api/fixmyui/agent/jobs/{id}/progress`

**Méthode :** `SaasClient.progress(jobId, message, type)`

Envoie un événement de progression en temps réel.

**Body :**
```json
{
  "message": "Writing src/components/Button.vue",
  "type": "action"
}
```

**Types de progression :**

| Type | Origine | Description |
|------|---------|-------------|
| `thinking` | ClaudeRunner | Claude raisonne |
| `action` | ClaudeRunner | Claude utilise un outil |
| `info` | Agent / ClaudeRunner | Message informatif |

Le message est tronqué à 900 caractères côté agent.

---

### `POST /api/fixmyui/agent/jobs/{id}/complete`

**Méthode :** `SaasClient.complete(jobId, { result_message, branch, preview_url, claude_code_version })`

Marque un job comme terminé avec succès.

**Body :**
```json
{
  "result_message": "Changes applied on branch fixmyui/a1b2c3d4.",
  "branch": "fixmyui/a1b2c3d4",
  "preview_url": "https://staging.myapp.com?branch=fixmyui/a1b2c3d4",
  "claude_code_version": "2.0.14 (Claude Code)"
}
```

- `claude_code_version` (optionnel) : sortie tronquée de `claude --version` sur la machine agent, affichée sur le dashboard installation.

- `branch` est `null` si aucun changement détecté (working tree clean)
- `preview_url` est `null` si `previewUrlTemplate` n'est pas configuré

---

### `POST /api/fixmyui/agent/jobs/{id}/fail`

**Méthode :** `SaasClient.fail(jobId, errorMessage)`

Marque un job comme échoué.

**Body :**
```json
{
  "error": "claude exited with code 1"
}
```

Appelé en best-effort (le `catch` est silencieux pour ne pas masquer l'erreur originale).

---

### `POST /api/fixmyui/agent/error`

**Méthode :** `SaasClient.reportError(message)`

Remonte une erreur non-job au SaaS (startup failure, déconnexion Reverb, etc.). Stockée dans `fixmyui_installations.last_agent_error` et affichée en bannière rouge dans le dashboard. Automatiquement effacée quand l'agent se reconnecte (`broadcastAuth`).

**Body :**
```json
{
  "message": "WebSocket disconnected — agent is no longer listening for jobs."
}
```

Best-effort : tous les `catch` sont silencieux, l'appel ne doit jamais crasher l'agent.

---

## Gestion d'erreurs

- Les erreurs HTTP (non-2xx) lèvent une `Error` avec le status code et le message d'erreur du body
- `ping()` tolère un 403 (canal test refusé = auth OK, canal invalide = attendu)
- `progress()` et `fail()` dans le pipeline de job sont wrappés en `.catch(() => {})` pour ne pas interrompre le flux
