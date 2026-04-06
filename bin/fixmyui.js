#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

program
  .name('fixmyui')
  .description('FixMyUI agent — lets PMs ship UI changes via Claude Code on your staging server.')
  .version(pkg.version, '-v, --version')
  .option('-c, --config <path>', 'Path to .fixmyui.json (default: .fixmyui.json in cwd)');

// ── init ─────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Interactive setup wizard — creates .fixmyui.json')
  .action(async () => {
    const { runInit } = await import('../src/commands/init.js');
    await runInit({ configPath: program.opts().config }).catch(handleError);
  });

// ── start ─────────────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the agent daemon and listen for jobs')
  .action(async () => {
    const { runStart } = await import('../src/commands/start.js');
    await runStart({ configPath: program.opts().config }).catch(handleError);
  });

// ── reset ─────────────────────────────────────────────────────────────────────
program
  .command('reset')
  .description('Remove .fixmyui.json — run fixmyui init afterwards')
  .action(async () => {
    const { runReset } = await import('../src/commands/reset.js');
    runReset({ configPath: program.opts().config });
  });

// ── test ──────────────────────────────────────────────────────────────────────
program
  .command('test')
  .description('Test config, SaaS connectivity, Claude CLI and git')
  .action(async () => {
    const { runTest } = await import('../src/commands/test.js');
    await runTest({ configPath: program.opts().config }).catch(handleError);
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show current configuration (agent secret is masked)')
  .action(async () => {
    const { loadConfig } = await import('../src/Config.js');
    let config;
    try {
      config = loadConfig(program.opts().config);
    } catch (err) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }

    const secret = config.agentSecret
      ? config.agentSecret.slice(0, 12) + '••••••••'
      : chalk.red('NOT SET');

    console.log('');
    console.log(chalk.bold.white('  FixMyUI Agent — status'));
    console.log('');
    row('SaaS URL',        config.apiUrl);
    row('Agent secret',    secret);
    row('Installation ID', config.installationId ?? chalk.yellow('run fixmyui init'));
    row('Repo path',       config.repoPath);
    row('Branch prefix',   config.branchPrefix);
    row('Auto-push',       config.autoPush ? 'yes' : 'no');
    row('Preview URL',     config.previewUrlTemplate ?? chalk.gray('not set'));
    row('Claude perms',    config.claudePermissionMode ?? 'acceptEdits');
    console.log('');
  });

// ── Default: show help if no command given ────────────────────────────────────
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv);

// ── Helpers ───────────────────────────────────────────────────────────────────

function handleError(err) {
  console.error(chalk.red(`\n  Error: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}

function row(label, value) {
  const padded = (label + '            ').slice(0, 16);
  console.log(`  ${chalk.gray(padded)}  ${value}`);
}
