/**
 * Terminal questions for LOGIN.mode 'auto': how to get past a detected login
 * screen. Only used when a person is at the keyboard — CI never prompts (see
 * decideNonInteractive).
 */
const readline = require('readline');
const { isCI } = require('../ci');

const interactive = () => !!(process.stdin.isTTY && process.stdout.isTTY) && !isCI();

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/** Read a line without echoing it (shows * per character). */
function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let buf = '';
    const finish = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(buf);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { if (buf) { buf = buf.slice(0, -1); stdout.write('\b \b'); } continue; }
        if (ch >= ' ') { buf += ch; stdout.write('*'); }
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

function describe(d) {
  if (d.kind === 'http') return `The server asks for ${d.authScheme || 'HTTP'} authentication.`;
  if (d.kind === 'sso') return `Pages redirect to a sign-in provider (${new URL(d.loginUrl).host}).`;
  return `Pages redirect to a login screen (${new URL(d.loginUrl).pathname}).`;
}

/**
 * Ask how to log in.
 * @returns {Promise<{method:'browser'} | {method:'credentials', username:string, password:string} | {method:'skip'}>}
 */
async function chooseLoginMethod(detected, log) {
  log('\n──────────────────────────────────────────────────────────────');
  log(`  Login required. ${describe(detected)}`);
  log('──────────────────────────────────────────────────────────────');
  const options = detected.kind === 'http'
    ? [['credentials', 'Enter username and password here'], ['skip', 'Skip protected pages — scan only what is public']]
    : [
      ['browser', `Log in myself in a browser window${detected.kind === 'sso' ? '  (recommended for SSO / MFA)' : '  (works with SSO, MFA, captchas)'}`],
      ['credentials', 'Enter username and password here  (password is not saved; only the session cookie is)'],
      ['skip', 'Skip protected pages — scan only what is public'],
    ];
  options.forEach(([, label], i) => log(`   ${i + 1}) ${label}`));
  let pick;
  while (!pick) {
    const a = await ask(`  Choose 1-${options.length} [1]: `);
    const n = a === '' ? 1 : Number(a);
    if (n >= 1 && n <= options.length) pick = options[n - 1][0];
  }
  if (pick !== 'credentials') return { method: pick };
  const username = await ask('  Username / email: ');
  const password = await askHidden('  Password: ');
  return { method: 'credentials', username, password };
}

/**
 * CI / piped runs: decide from the environment, never prompt.
 *   A11Y_USER + A11Y_PASS  → log in with the detected form (or HTTP auth)
 *   --public-only / A11Y_PUBLIC_ONLY=1 → skip protected pages
 *   otherwise → fail with instructions
 * (A saved session from A11Y_STORAGE_STATE never reaches here: lib/ci.js
 * turns it into a reused session before detection runs.)
 */
function decideNonInteractive(detected, { publicOnly } = {}) {
  const env = process.env;
  if (env.A11Y_USER && env.A11Y_PASS && detected.kind !== 'sso') return { method: 'credentials', username: env.A11Y_USER, password: env.A11Y_PASS };
  if (env.A11Y_USER && env.A11Y_PASS && detected.kind === 'sso') return { method: 'credentials', username: env.A11Y_USER, password: env.A11Y_PASS, note: 'SSO login with credentials is best-effort; MFA cannot be automated — prefer A11Y_STORAGE_STATE.' };
  if (publicOnly) return { method: 'skip' };
  return {
    method: 'fail',
    message: [
      `Login required (${describe(detected)}) and nobody is here to log in.`,
      'Give the scan a way in — one of:',
      '  A11Y_USER / A11Y_PASS             a test account; the detected login form is filled in',
      `  A11Y_STORAGE_STATE(_B64)          a saved session (run \`${require('../cliName')()} login\` locally to create one)`,
      '  --public-only  (A11Y_PUBLIC_ONLY=1)  scan only the pages that need no login',
    ].join('\n'),
  };
}

/** JS-literal source for a plain object (single quotes, unquoted keys). */
function toJs(v, indent = '  ') {
  if (Array.isArray(v)) return `[\n${v.map((x) => indent + '  ' + toJs(x, indent + '  ')).join(',\n')},\n${indent}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${toJs(x, indent)}`).join(', ')} }`;
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return String(v);
}

/**
 * Offer to write the working LOGIN block into the config so CI (and the next
 * person) can reuse it. Only replaces a simple one-level `LOGIN: { … }` entry;
 * anything more elaborate is printed for the user to paste instead.
 */
async function offerSaveLogin(configFile, loginBlock, log) {
  const path = require('path');
  const fs = require('fs');
  const rel = path.relative(process.cwd(), configFile) || configFile;
  const a = await ask(`  Save these login settings to ${rel}? Credentials are never written — CI supplies them as A11Y_USER / A11Y_PASS. [y/N]: `);
  if (!/^y(es)?$/i.test(a)) return false;
  const block = { ...loginBlock, stateFile: path.basename(loginBlock.stateFile) };
  const literal = `LOGIN: ${toJs(block)}`;
  let src = '';
  try { src = fs.readFileSync(configFile, 'utf8'); } catch { /* in-memory config */ }
  const re = /LOGIN\s*:\s*\{[^{}]*\}/g;
  const hits = src.match(re) || [];
  if (src && hits.length === 1) {
    fs.writeFileSync(configFile, src.replace(re, literal));
    log(`  ✔ Saved LOGIN to ${rel}`);
    return true;
  }
  log(`  Could not update ${rel} automatically — paste this into it:\n\n  ${literal},\n`);
  return false;
}

module.exports = { interactive, ask, askHidden, chooseLoginMethod, decideNonInteractive, describe, offerSaveLogin, toJs };
