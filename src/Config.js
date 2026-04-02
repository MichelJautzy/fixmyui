import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import dotenv from 'dotenv';

const CONFIG_FILENAME = '.fixmyui.json';

/**
 * Load configuration from .fixmyui.json and environment variables.
 * Environment variables take priority over .fixmyui.json.
 *
 * @param {string} [cwd] Directory to search for .fixmyui.json (default: process.cwd())
 * @returns {Config}
 */
export function loadConfig(cwd = process.cwd()) {
  // Load .env if present (silently — not required)
  const dotenvPath = join(cwd, '.env');
  if (existsSync(dotenvPath)) {
    dotenv.config({ path: dotenvPath });
  }

  const file = findConfigFile(cwd);
  const fileConfig = file ? parseJsonFile(file) : {};

  const config = {
    apiUrl:             env('FIXMYUI_API_URL')              ?? fileConfig.apiUrl              ?? 'https://fixmyui.com',
    agentSecret:        env('FIXMYUI_AGENT_SECRET')         ?? fileConfig.agentSecret         ?? null,
    installationId:     env('FIXMYUI_INSTALLATION_ID')      ?? fileConfig.installationId      ?? null,
    repoPath:           resolve(cwd, fileConfig.repoPath    ?? '.'),
    branchStrategy:     env('FIXMYUI_BRANCH_STRATEGY')      ?? fileConfig.branchStrategy      ?? 'new-branch',
    branchPrefix:       env('FIXMYUI_BRANCH_PREFIX')        ?? fileConfig.branchPrefix        ?? 'fixmyui',
    branchName:         env('FIXMYUI_BRANCH_NAME')          ?? fileConfig.branchName          ?? 'fixmyui',
    autoPush:           envBool('FIXMYUI_AUTO_PUSH')        ?? fileConfig.autoPush            ?? true,
    postCommands:       fileConfig.postCommands             ?? [],
    previewUrlTemplate: env('FIXMYUI_PREVIEW_URL_TEMPLATE') ?? fileConfig.previewUrlTemplate  ?? null,
    reverbAppKey:       env('FIXMYUI_REVERB_APP_KEY')       ?? fileConfig.reverbAppKey       ?? null,
    reverbHost:         env('FIXMYUI_REVERB_HOST')          ?? fileConfig.reverbHost         ?? null,
    reverbPort:         envInt('FIXMYUI_REVERB_PORT')       ?? fileConfig.reverbPort         ?? null,
    reverbScheme:       env('FIXMYUI_REVERB_SCHEME')        ?? fileConfig.reverbScheme       ?? null,
    claudePermissionMode: env('FIXMYUI_CLAUDE_PERMISSION_MODE') ?? fileConfig.claudePermissionMode ?? 'acceptEdits',
  };

  config.apiUrl = config.apiUrl.replace(/\/$/, '');

  return config;
}

/**
 * Validate config and throw a descriptive error for missing required fields.
 * @param {Config} config
 */
export function validateConfig(config) {
  if (!config.agentSecret) {
    throw new Error(
      'Missing agentSecret.\n' +
      'Run `fixmyui init` or set FIXMYUI_AGENT_SECRET in .env / .fixmyui.json'
    );
  }
  if (!config.apiUrl.startsWith('http')) {
    throw new Error(`Invalid apiUrl: "${config.apiUrl}" — must start with http:// or https://`);
  }
}

/**
 * Write config to .fixmyui.json (used by `fixmyui init`).
 * @param {Partial<Config>} values
 * @param {string} [cwd]
 */
export function writeConfig(values, cwd = process.cwd()) {
  const path = join(cwd, CONFIG_FILENAME);
  writeFileSync(path, JSON.stringify(values, null, 2) + '\n', 'utf8');
}

/**
 * Return the path to the config file if it exists, otherwise null.
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function configFilePath(cwd = process.cwd()) {
  return findConfigFile(cwd);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findConfigFile(cwd) {
  const path = join(cwd, CONFIG_FILENAME);
  return existsSync(path) ? path : null;
}

function parseJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Could not parse ${path} — check JSON syntax.`);
  }
}

function env(key) {
  const v = process.env[key];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

function envBool(key) {
  const v = env(key);
  if (v === undefined) return undefined;
  return v.toLowerCase() !== 'false' && v !== '0';
}

function envInt(key) {
  const v = env(key);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * @typedef {object} Config
 * @property {string}       apiUrl
 * @property {string|null}  agentSecret
 * @property {string}       repoPath
 * @property {string}       branchStrategy       'new-branch' | 'same-branch' | 'local-branch'
 * @property {string}       branchPrefix         Used when branchStrategy='new-branch'
 * @property {string}       branchName           Used when branchStrategy='same-branch'
 * @property {boolean}      autoPush
 * @property {Array<{label:string, command:string}>} postCommands  Shell commands to run after Claude finishes
 * @property {string|null}  previewUrlTemplate
 * @property {string|null}  reverbAppKey
 * @property {string|null}  reverbHost
 * @property {number|null}  reverbPort
 * @property {string|null}  reverbScheme
 * @property {string}       claudePermissionMode  acceptEdits | dontAsk | auto | plan | default | bypassPermissions
 */
