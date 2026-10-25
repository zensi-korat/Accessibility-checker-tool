/**
 * Command hints follow the package manager the user ran the tool with:
 * pnpm exec / yarn / bunx / npx, falling back to the project's lockfile, and
 * the bare bin name for a global install.
 *
 *   node test/cliName.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cliName = require('../lib/cliName');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-cli-'));
const local = ['node', path.join(dir, 'node_modules', '.bin', 'accessibility-check')];
check(cliName({ env: { npm_config_user_agent: 'pnpm/10.4.1 npm/? node/v22' }, argv: local, cwd: dir }) === 'pnpm exec accessibility-check', 'pnpm exec → pnpm exec accessibility-check');
check(cliName({ env: { npm_config_user_agent: 'yarn/4.1.0 npm/? node/v22' }, argv: local, cwd: dir }) === 'yarn accessibility-check', 'yarn → yarn accessibility-check');
check(cliName({ env: { npm_config_user_agent: 'bun/1.1.0' }, argv: local, cwd: dir }) === 'bunx accessibility-check', 'bun → bunx accessibility-check');
check(cliName({ env: { npm_config_user_agent: 'npm/10.9.2 node/v22', npm_command: 'exec' }, argv: local, cwd: dir }) === 'npx accessibility-check', 'npx → npx accessibility-check');
fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
check(cliName({ env: {}, argv: local, cwd: path.join(dir) }) === 'pnpm exec accessibility-check', 'started from node_modules/.bin with no agent: the lockfile decides (pnpm)');
fs.mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
check(cliName({ env: {}, argv: local, cwd: path.join(dir, 'apps', 'web') }) === 'pnpm exec accessibility-check', 'finds the lockfile in a parent folder (monorepo)');
check(cliName({ env: {}, argv: ['node', '/usr/local/bin/accessibility-check'], cwd: os.tmpdir() }) === 'accessibility-check', 'global install → bare command');
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exitCode = failures ? 1 : 0;
