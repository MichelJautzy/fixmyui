import { input, password, confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { writeConfig, loadConfig } from '../Config.js';
import { SaasClient } from '../SaasClient.js';
import { GitHelper } from '../agent/GitHelper.js';
import { existsSync } from 'fs';
import { resolve } from 'path';

export async function runInit() {
  console.log('');
  console.log(chalk.bold.white('  FixMyUI — setup wizard'));
  console.log(chalk.gray('  This will create a .fixmyui.json file in the current directory.\n'));

  const cwd = process.cwd();

  // Warn if a config already exists
  if (existsSync(resolve(cwd, '.fixmyui.json'))) {
    const overwrite = await confirm({
      message: chalk.yellow('.fixmyui.json already exists. Overwrite?'),
      default: false,
    });
    if (!overwrite) {
      console.log(chalk.gray('  Aborted.'));
      process.exit(0);
    }
  }

  // ── Step 1: SaaS URL ──────────────────────────────────────────────────────
  const apiUrl = await input({
    message: 'FixMyUI SaaS URL',
    default: 'https://fixmyui.com',
    validate: (v) => v.startsWith('http') || 'Must start with http:// or https://',
  });

  // ── Step 2: Agent secret ──────────────────────────────────────────────────
  console.log(chalk.gray('\n  Tip: find your agent secret in the FixMyUI dashboard'));
  console.log(chalk.gray('       → fixmyui.com/fixmyui → your installation → "Save your agent secret"\n'));

  const agentSecret = await password({
    message: 'Agent secret (fmui_sk_...)',
    validate: (v) => v.startsWith('fmui_sk_') || 'Must start with fmui_sk_',
  });

  // ── Step 3: Verify credentials + fetch installation ID ───────────────────
  const spinner = (await import('ora')).default('Verifying credentials…').start();
  let installationId;
  let installationName;
  let me;

  try {
    const client = new SaasClient({ apiUrl: apiUrl.replace(/\/$/, ''), agentSecret });
    me = await client.me();
    installationId   = me.installation_id;
    installationName = me.name;
    if (!me.reverb?.key) {
      spinner.fail(chalk.red('SaaS /me response missing Reverb config — update FixMyUI SaaS.'));
      process.exit(1);
    }
    spinner.succeed(chalk.green(`Connected — installation: "${installationName}" (ID: ${installationId})`));
  } catch (err) {
    spinner.fail(chalk.red(`Authentication failed: ${err.message}`));
    process.exit(1);
  }

  // ── Step 4: Repo path ─────────────────────────────────────────────────────
  const repoPath = await input({
    message: 'Path to the git repository root',
    default: '.',
    validate: async (v) => {
      const abs = resolve(cwd, v);
      if (!existsSync(abs)) return `Directory "${abs}" does not exist`;
      try {
        await new GitHelper(abs).assertIsRepo();
        return true;
      } catch {
        return `"${abs}" is not a git repository`;
      }
    },
  });

  // ── Step 5: Branch prefix ─────────────────────────────────────────────────
  const branchPrefix = await input({
    message: 'Git branch prefix (e.g. fixmyui → fixmyui/abc12345)',
    default: 'fixmyui',
    validate: (v) => /^[a-z0-9_/-]+$/i.test(v) || 'Use letters, numbers, hyphens, slashes or underscores',
  });

  // ── Step 6: Auto-push ─────────────────────────────────────────────────────
  const autoPush = await confirm({
    message: 'Automatically push branches after Claude commits?',
    default: true,
  });

  // ── Step 7: Preview URL template (optional) ───────────────────────────────
  const wantPreview = await confirm({
    message: 'Configure a preview URL template? (optional)',
    default: false,
  });

  let previewUrlTemplate = null;
  if (wantPreview) {
    previewUrlTemplate = await input({
      message: 'Preview URL template (use {branch} as placeholder)',
      placeholder: 'https://staging.myapp.com?branch={branch}',
    });
  }

  // ── Write config ──────────────────────────────────────────────────────────
  const configData = {
    apiUrl:           apiUrl.replace(/\/$/, ''),
    agentSecret,
    installationId,
    repoPath,
    branchPrefix,
    autoPush,
    previewUrlTemplate: previewUrlTemplate || null,
    reverbAppKey:     me.reverb.key,
    reverbHost:       me.reverb.host,
    reverbPort:       me.reverb.port,
    reverbScheme:     me.reverb.scheme,
  };

  writeConfig(configData, cwd);

  console.log('');
  console.log(chalk.green.bold('  .fixmyui.json created.'));
  console.log('');
  console.log(chalk.gray('  Reminder: add .fixmyui.json to .gitignore to protect your secret.'));
  console.log('');
  console.log('  Next steps:');
  console.log(chalk.cyan('    fixmyui test    ') + chalk.gray('— verify the full connection'));
  console.log(chalk.cyan('    fixmyui start   ') + chalk.gray('— start the agent daemon'));
  console.log('');
}
