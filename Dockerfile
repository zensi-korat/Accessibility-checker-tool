# Accessibility scanner as a container — for teams that don't use Node, and
# for CI runners without a browser. Nothing project-specific is baked in.
#
#   docker build -t accessibility-check .
#   # from the root of the project to scan (it holds a11y.config.js):
#   docker run --rm -v "$PWD:/work" -e A11Y_BASE_URL=http://host.docker.internal:3000 accessibility-check scan
#   docker run --rm -v "$PWD:/work" accessibility-check init --url http://host.docker.internal:3000
#   # no project at all — just a URL:
#   docker run --rm -v "$PWD:/work" accessibility-check scan https://staging.example.com
#
# The app runs OUTSIDE the container: on macOS/Windows reach it via
# host.docker.internal; on Linux add `--add-host=host.docker.internal:host-gateway`
# or use `--network host` with http://localhost:<port>.
# Reports are written into the mounted project (a11y-report/), owned by root
# unless you pass `--user "$(id -u):$(id -g)"`.
FROM node:22-bookworm-slim

# Browsers in a fixed, user-independent place (works with --user too).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/a11y
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

# Only the code the tool runs — never configs, sessions or reports from this folder.
COPY bin ./bin
COPY lib ./lib
COPY playwright ./playwright
COPY templates ./templates
COPY scan.js render.js combine-reports.js wcag-criteria.js ./
COPY docs ./docs
COPY examples ./examples

ENV A11Y_CI=1 \
    A11Y_HEADLESS=1
WORKDIR /work
ENTRYPOINT ["node", "/opt/a11y/bin/a11y.js"]
CMD ["--help"]
