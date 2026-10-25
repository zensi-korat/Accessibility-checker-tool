const { test: base, expect } = require('@playwright/test');
const { withA11y } = require('../../../../playwright');
exports.test = withA11y(base);
exports.expect = expect;
