const jsxA11y = require('eslint-plugin-jsx-a11y');
module.exports = [
  { ignores: ['ignored/**'] },
  {
    files: ['**/*.jsx'],
    plugins: { 'jsx-a11y': jsxA11y },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { 'jsx-a11y': { components: { Image: 'img' } } },
    rules: { 'jsx-a11y/iframe-has-title': 'off' },
  },
];
