import { input, password, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { writeConfig } from '../Config.js';
import { SaasClient } from '../SaasClient.js';
import { GitHelper } from '../agent/GitHelper.js';
import { existsSync } from 'fs';
import { resolve } from 'path';

export async function runInit({ configPath } = {}) {
  console.log('');
  console.log(chalk.bold.white('  FixMyUI — setup wizard'));
  console.log(chalk.gray('  This will create a .fixmyui.json file in the current directory.\n'));

  const cwd = process.cwd();
  const targetFile = configPath ?? resolve(cwd, '.fixmyui.json');

  if (existsSync(targetFile)) {
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

  // ── Step 3: Verify credentials + fetch remote config ───────────────────
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

  // ── Step 4: Repo path (local-only setting) ─────────────────────────────
  const repoPath = await input({
    message: 'Absolute path to the git repository root',
    default: resolve(cwd, '.'),
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

  // Only local identity fields — remote config (branch strategy, auto-push,
  // prompt rules, etc.) is always fetched live from the SaaS at startup and
  // before each job, so it does not belong in the file.
  const configData = {
    apiUrl:       apiUrl.replace(/\/$/, ''),
    agentSecret,
    installationId,
    repoPath:     resolve(cwd, repoPath),
    reverbAppKey: me.reverb.key,
    reverbHost:   me.reverb.host,
    reverbPort:   me.reverb.port,
    reverbScheme: me.reverb.scheme,
  };

  writeConfig(configData, configPath);

  const remoteConfig = me.config ?? {};
  const strategy = remoteConfig.branch_strategy ?? 'new-branch';
  const strategyLabels = {
    'new-branch': 'New branch per job',
    'same-branch': `Fixed branch (${remoteConfig.branch_name ?? 'fixmyui'})`,
    'local-branch': 'Stay on current branch',
  };

  console.log('');
  console.log(chalk.green.bold('  .fixmyui.json created.'));
  console.log('');
  console.log(chalk.gray('  Dashboard config (synced at runtime — not stored locally):'));
  console.log(chalk.gray(`    Branch strategy : ${strategyLabels[strategy] ?? strategy}`));
  console.log(chalk.gray(`    Auto-push       : ${(remoteConfig.auto_push ?? true) ? 'yes' : 'no'}`));
  console.log(chalk.gray(`    Post-commands   : ${(remoteConfig.post_commands ?? []).length} configured`));
  if (remoteConfig.preview_url_template) {
    console.log(chalk.gray(`    Preview URL     : ${remoteConfig.preview_url_template}`));
  }
  console.log('');
  console.log(chalk.gray('  Reminder: add .fixmyui.json to .gitignore to protect your secret.'));
  console.log(chalk.gray('  Tip: change these settings from the FixMyUI dashboard — they sync automatically.'));
  console.log('');
  console.log('  Next steps:');
  console.log(chalk.cyan('    fixmyui test    ') + chalk.gray('— verify the full connection'));
  console.log(chalk.cyan('    fixmyui start   ') + chalk.gray('— start the agent daemon'));
  console.log('');
}
