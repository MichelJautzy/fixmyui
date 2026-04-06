import { unlinkSync } from 'fs';
import chalk from 'chalk';
import { configFilePath } from '../Config.js';

/**
 * Remove .fixmyui.json from the current working directory (or --config path).
 */
export function runReset({ configPath } = {}) {
  const file = configFilePath(configPath);

  console.log('');

  if (!file) {
    console.log(chalk.yellow(`  No .fixmyui.json found — nothing to remove.`));
    console.log('');
    console.log(chalk.gray('  Run ') + chalk.cyan('fixmyui init') + chalk.gray(' when you are ready to configure the agent.'));
    console.log('');
    return;
  }

  unlinkSync(file);
  console.log(chalk.green(`  Removed ${file}`));
  console.log('');
  console.log(chalk.gray('  Next step: run ') + chalk.cyan.bold('fixmyui init') + chalk.gray(' to set up the agent again.'));
  console.log('');
}
