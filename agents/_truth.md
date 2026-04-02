# Vérité Produit — FixMyUI Agent

> **NON MODIFIABLE.** Ce fichier décrit ce qu'est le produit et ses règles architecturales fondamentales. Il ne doit pas évoluer avec le code — il représente la vision et l'intention du projet. Toute fonctionnalité doit servir cette vision.

---

## Vision Produit

**fixmyui-agent** est un package npm CLI qui tourne sur le serveur de staging du client. Il connecte un repo git existant à la plateforme [fixmyui.com](https://fixmyui.com), écoute les demandes de correction UI émises par les Product Managers via un widget, exécute Claude Code pour appliquer les changements, puis commit et push le résultat — le tout en temps réel.

L'objectif est de permettre aux PMs de livrer des corrections UI directement sur le staging, sans intervention développeur.

---

## Règles Architecturales Intangibles

Ces règles ne changent pas. Toute décision technique doit les respecter.

### 1. Agent-side uniquement

Ce repo est le **client CLI** uniquement. Le backend SaaS (Laravel, Reverb, base de données, Stripe) vit dans le repo `saas` sous `app/Modules/FixMyUI/`. Ce repo ne contient aucune logique serveur — il consomme l'API.

### 2. Communication temps réel via Reverb (Pusher)

- L'agent se connecte au WebSocket Reverb de fixmyui.com
- Le canal privé `private-fixmyui.agent.{installationId}` est la seule source de jobs
- L'authentification du canal se fait via HMAC avec l'`agentSecret`
- Pas de polling HTTP — WebSocket only pour la réception des jobs

### 3. Claude Code en mode headless

- L'agent spawne `claude` CLI avec `--output-format stream-json` et `--permission-mode`
- Le mode par défaut est `acceptEdits` (auto-approve des éditions de fichiers)
- L'agent ne doit **jamais** requérir d'interaction humaine au terminal
- Le streaming des événements Claude (thinking, action, result) est relayé au SaaS en temps réel

### 4. Git : branches isolées, jamais toucher main

- Chaque job crée une branche `{branchPrefix}/{job_id_short}`
- L'agent restaure la branche originale en cas d'échec
- Le push est optionnel (`autoPush` config)
- L'agent ne fait **jamais** de merge, rebase ou force push

### 5. Sécurité du secret agent

- L'`agentSecret` (`fmui_sk_xxx`) n'est **jamais** commité dans le repo
- Le SaaS ne stocke que le `sha256` du secret
- La configuration locale vit dans `.fixmyui.json` (gitignored) ou en variables d'environnement

### 6. Zero-dependency sur le projet cible

- L'agent s'installe globalement (`npm install -g fixmyui-agent`)
- Il ne modifie pas le `package.json` du projet cible
- Il n'ajoute aucun fichier au repo cible (sauf les changements Claude)

---

## Stack Technique

| Couche | Technologie |
|--------|-------------|
| Runtime | Node.js 18+ |
| CLI framework | Commander |
| WebSocket | pusher-js (Reverb-compatible) |
| Git | simple-git |
| AI | Claude Code CLI (spawn process) |
| Config | dotenv + .fixmyui.json |
| UX terminal | chalk, ora, @inquirer/prompts |

---

## Entité Légale

Opéré par :

| Champ | Valeur |
|-------|--------|
| Nom | EMERGIA INTELLIGENCE LLC |
| Type | Limited Liability Company (Wyoming) |
| Adresse | 5830 E 2ND ST, STE 7000 #28965, CASPER, WY 82609 |
| Email | big.beard.development@gmail.com |
