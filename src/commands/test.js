import chalk from 'chalk';
import { execSync } from 'child_process';
import { loadConfig, validateConfig } from '../Config.js';
import { SaasClient } from '../SaasClient.js';
import { GitHelper } from '../agent/GitHelper.js';

export async function runTest() {
  console.log('');
  console.log(chalk.bold.white('  FixMyUI — connection test\n'));

  let config;

  // ── 1. Config ─────────────────────────────────────────────────────────────
  process.stdout.write('  Config         ');
  try {
    config = loadConfig();
    validateConfig(config);
    ok('loaded');
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }

  // ── 2. Claude CLI ─────────────────────────────────────────────────────────
  process.stdout.write('  Claude CLI     ');
  try {
    const version = execSync('claude --version', { encoding: 'utf8' }).trim();
    ok(version);
  } catch {
    fail('`claude` not found — install Claude Code: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  // ── 3. Git repo ───────────────────────────────────────────────────────────
  process.stdout.write('  Git repo       ');
  try {
    const git = new GitHelper(config.repoPath);
    await git.assertIsRepo();
    const branch = await git.currentBranch();
    ok(`on branch "${branch}"`);
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }

  // ── 4. SaaS connectivity ──────────────────────────────────────────────────
  process.stdout.write('  SaaS API       ');
  const saas = new SaasClient(config);

  try {
    const me = await saas.me();
    ok(`installation "${me.name}" (ID: ${me.installation_id})`);
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }

  // ── 5. Reverb WebSocket ───────────────────────────────────────────────────
  process.stdout.write('  Reverb WS      ');
  try {
    await testReverbConnection(config);
    ok('connected');
  } catch (err) {
    fail(`${err.message} (is the Reverb server running?)`);
    process.exit(1);
  }

  console.log('');
  console.log(chalk.green.bold('  All checks passed.'));
  console.log(chalk.gray(`\n  Run ${chalk.cyan('fixmyui start')} to begin.\n`));
}

async function testReverbConnection(config) {
  const { ReverbClient } = await import('../agent/ReverbClient.js');

  return new Promise((resolve, reject) => {
    const client = new ReverbClient(config);
    const installationId = config.installationId;

    const timeout = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timed out after 5s'));
    }, 5000);

    client.once('connected', () => {
      clearTimeout(timeout);
      client.disconnect();
      resolve();
    });

    client.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    client.connect(installationId);
  });
}

function ok(detail) {
  console.log(chalk.green('✓') + chalk.gray(` ${detail}`));
}

function fail(detail) {
  console.log(chalk.red('✗') + chalk.red(` ${detail}`));
}
