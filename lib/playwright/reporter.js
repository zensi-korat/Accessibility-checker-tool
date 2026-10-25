/**
 * Playwright reporter: at the end of the run, builds the accessibility report
 * from every a11y.check() made by the fixture.
 *
 *   reporter: [['list'], ['<tool>/playwright/reporter.js', { failOnGate: true }]]
 *
 * Options:
 *   config      path to a11y.config.js (default ./a11y.config.js if present)
 *   failOnGate  false  mark the run failed when the quality gate fails
 *                      (thresholds: FAIL_ON in the config or A11Y_FAIL_ON_* env)
 *   finalize    true   false for sharded runs — keep the raw files and run
 *                      `a11y e2e-report` once all shards are pooled
 */
const fs = require('fs');
const { loadE2eConfig, scansDir } = require('./shared');
const { finalizeE2e } = require('./e2eReport');

class A11yReporter {
  constructor(options = {}) { this.options = options; }

  printsToStdio() { return false; }

  onBegin() {
    // Start every run clean, so results from an earlier run never leak in.
    // Shards keep their files: they are pooled by `a11y e2e-report`.
    if (this.options.finalize === false) return;
    const config = loadE2eConfig(this.options.config);
    fs.rmSync(scansDir(config), { recursive: true, force: true });
  }

  async onEnd() {
    if (this.options.finalize === false) return undefined;
    const config = loadE2eConfig(this.options.config);
    const prevExit = process.exitCode;
    const result = finalizeE2e(config);
    process.exitCode = prevExit; // the gate decides via the returned status, not a stray exit code
    if (result && result.gate.failed && this.options.failOnGate) return { status: 'failed' };
    return undefined;
  }
}

module.exports = A11yReporter;
