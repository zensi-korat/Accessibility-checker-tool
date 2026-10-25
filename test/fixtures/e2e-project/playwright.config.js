const path = require('path');
module.exports = {
  testDir: './tests',
  outputDir: './test-results',
  workers: 2,
  reporter: [['line'], [path.join(__dirname, '../../../playwright/reporter.js'), { failOnGate: false }]],
  use: { baseURL: 'http://localhost:4791' },
  webServer: { command: 'node server.js', url: 'http://localhost:4791/app', reuseExistingServer: true, cwd: __dirname },
};
