/**
 * How the user should type the next command, in the package manager they
 * actually used:
 *
 *   pnpm exec accessibility-check …   ran via pnpm (pnpm exec / pnpm script)
 *   yarn accessibility-check …        ran via yarn
 *   bunx accessibility-check …        ran via bun
 *   npx accessibility-check …         ran via npx / npm, or a project whose
 *                                     lockfile doesn't say otherwise
 *   accessibility-check …             installed globally and run directly
 *
 * The package manager announces itself in npm_config_user_agent
 * ("pnpm/10.4.1 npm/? node/…"). When that is missing (the tool was started
 * directly from node_modules/.bin, say), the project's lockfile decides.
 */
const fs = require('fs');
const path = require('path');

const BIN = 'accessibility-check';
const FORMS = {
  pnpm: `pnpm exec ${BIN}`,
  yarn: `yarn ${BIN}`,
  bun: `bunx ${BIN}`,
  npm: `npx ${BIN}`,
};

function fromLockfile(start) {
  let dir = path.resolve(start || process.cwd());
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun';
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

module.exports = function cliName({ env = process.env, argv = process.argv, cwd = process.cwd() } = {}) {
  const agent = String(env.npm_config_user_agent || '').match(/^(pnpm|yarn|bun|npm)\//);
  if (agent) return FORMS[agent[1]];
  const installedHere = /[\\/]node_modules[\\/]/.test(argv[1] || '');
  const viaNpx = env.npm_command === 'exec' || /[\\/]_npx[\\/]/.test(argv[1] || '');
  if (installedHere || viaNpx) return FORMS[fromLockfile(cwd) || 'npm'];
  return BIN; // a global install: the bin is on PATH
};
