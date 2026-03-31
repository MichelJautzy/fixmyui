import chalk from 'chalk';
import { loadConfig, validateConfig } from '../Config.js';
import { ensureReverbConfig } from '../ensureReverbConfig.js';
import { Agent } from '../agent/Agent.js';

export async function runStart() {
  let config;

  try {
    config = loadConfig();
    validateConfig(config);
    config = await ensureReverbConfig(config);
  } catch (err) {
    console.error(chalk.red(`\n  Config error: ${err.message}\n`));
    process.exit(1);
  }

  const installationId = config.installationId;
  if (!installationId) {
    console.error(chalk.red(
      '\n  Missing installationId in .fixmyui.json.\n' +
      '  Run `fixmyui init` to set it up.\n'
    ));
    process.exit(1);
  }

  // Print startup banner
  console.log('');
  console.log(chalk.bold.white('  FixMyUI Agent'));
  console.log(chalk.gray(`  SaaS       : ${config.apiUrl}`));
  console.log(chalk.gray(`  Repo       : ${config.repoPath}`));
  console.log(chalk.gray(`  Branch     : ${config.branchPrefix}/<job_id>`));
  console.log(chalk.gray(`  Auto-push  : ${config.autoPush ? 'yes' : 'no'}`));
  console.log(chalk.gray(`  Reverb     : ${config.reverbScheme ?? 'http'}://${config.reverbHost ?? '—'}:${config.reverbPort ?? '—'} (key …${String(config.reverbAppKey).slice(-6)})`));
  console.log(chalk.gray(`  Claude     : permission-mode=${config.claudePermissionMode ?? 'acceptEdits'}`));
  console.log('');

  const agent = new Agent(config, {
    log: (msg) => console.log(chalk.gray(new Date().toLocaleTimeString()) + '  ' + msg),
  });

  agent.connect(installationId);

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(chalk.yellow(`\n  ${signal} received — shutting down…`));
    agent.disconnect();
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep the process alive
  await new Promise(() => {});
}
