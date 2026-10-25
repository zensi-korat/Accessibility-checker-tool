# Publishing accessibility-check to npm

For maintainers. Publishing a **public** package on npmjs.com is free.

## Before the first release (once)

1. **Get permission to open-source it.** This was built as company work, so confirm the company is fine releasing it under the MIT license (`LICENSE`). If the copyright holder should be the company, change the `Copyright` line.
2. **Create an npm account** at <https://www.npmjs.com/signup> and turn on **two-factor authentication** (Account → Two-Factor Authentication → "Authorization and writes").
3. **Check the name is still free:**
   ```bash
   npm view accessibility-check      # "404 Not Found" = free
   ```
   npm also blocks names that differ only by punctuation from an existing package. If the publish is refused, pick another name and change `name` and the `npx accessibility-check` examples in the docs.
4. **Put the code on GitHub** (public repository). Then add these to `package.json`, which lets npm link back to the code:
   ```json
   "repository": { "type": "git", "url": "git+https://github.com/<you>/accessibility-check.git" },
   "homepage": "https://github.com/<you>/accessibility-check#readme",
   "bugs": "https://github.com/<you>/accessibility-check/issues",
   "author": "<name>"
   ```
5. **Check what will be published.** Only the folders listed in `"files"` ship. Confirm there are no session files, reports or test fixtures:
   ```bash
   npm pack --dry-run
   ```
6. **Try the package as a user would**, from a different folder:
   ```bash
   npm pack                                    # → accessibility-check-0.1.0.tgz
   cd /some/react-app
   npx --yes /path/to/accessibility-check-0.1.0.tgz lint
   npx --yes /path/to/accessibility-check-0.1.0.tgz scan http://localhost:5173
   ```

## First publish (by hand)
```bash
npm login                 # opens the browser
npm test                  # also runs automatically before publish
npm publish --access public
```
Then check <https://www.npmjs.com/package/accessibility-check> and try `npx accessibility-check --help` on another machine.

## Later releases (automated)
`.github/workflows/publish.yml` publishes whenever a version tag is pushed. It runs the tests, checks the tag matches `package.json`, and publishes with **provenance**, a signed statement linking the package to the commit that built it.

One-time setup: on npmjs.com open the package → **Settings → Trusted publishing → GitHub Actions**, and enter your GitHub user/org, the repository, and the workflow file `publish.yml`. No npm token needs to be stored in GitHub.

Each release:
```bash
# update CHANGELOG.md, then:
npm version patch        # 0.1.0 → 0.1.1 (fixes)   | minor: new features | major: breaking changes
git push --follow-tags   # the tag triggers the publish workflow
```

**Versioning:** the CI templates install `accessibility-check@0`, so every 0.x release reaches users automatically. Breaking changes (config format, CLI flags, report.json shape) need a major version, and the templates need updating to match.

## If something goes wrong
- **Bad release:** `npm deprecate accessibility-check@0.1.1 "broken, use 0.1.2"` and publish a fix. Unpublishing is only allowed within 72 hours and is discouraged.
- **"You do not have permission to publish":** the name is taken or too similar to an existing one. Choose another name.
- **"403 … two-factor":** run `npm publish --otp=123456` with the code from your authenticator app.
