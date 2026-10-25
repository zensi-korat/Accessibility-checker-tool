/**
 * Best-effort mapping of a live DOM violation back to source code.
 *
 * Runtime HTML (Razor/.aspx) rarely matches source 1:1, so we extract the
 * strongest, most unique clues from the offending element and grep the repo:
 *   id  >  image filename  >  aria-label/title  >  unusual class combo  >  text
 * Returns ranked {file, line, snippet, clue} guesses. It gets you close;
 * it is not a guaranteed exact line.
 */
const fs = require('fs');
const path = require('path');

function buildIndex(repoPath, extensions) {
  const files = [];
  if (!repoPath) return files;
  const skipDirs = new Set(['node_modules', '.git', 'bin', 'obj', 'packages', 'dist', 'wwwroot/lib', '.vs',
    'build', 'out', '.next', '.nuxt', '.angular', 'coverage', '.turbo', '.cache', 'storybook-static', 'vendor']);
  const TEST_FILE = /\.(test|spec|stories|e2e|cy)\.[cm]?[jt]sx?$|\.d\.ts$|\.min\.js$/i;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        walk(full);
      } else if (extensions.includes(path.extname(e.name).toLowerCase()) && !TEST_FILE.test(e.name)) {
        files.push(full);
      }
    }
  };
  walk(repoPath);
  return files;
}

/** Read files lazily and cache by path. */
function makeReader() {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { /* ignore */ }
    cache.set(file, lines);
    return lines;
  };
}

// Pull unique, searchable clues out of an axe node, best first.
function cluesFromNode(node, stripIds = true) {
  const stripServerId = stripIds ? stripWebFormsId : (id) => id;
  const html = (node.html || '').slice(0, 400);
  const target = Array.isArray(node.target) ? node.target.join(' ') : '';
  const clues = [];

  const idMatch = html.match(/\bid="([^"]{2,})"/i);
  if (idMatch) clues.push({ kind: 'id', value: stripServerId(idMatch[1]), weight: 5 });

  const srcMatch = html.match(/\bsrc="([^"]+)"/i);
  if (srcMatch) {
    const file = srcMatch[1].split(/[\\/]/).pop().split('?')[0];
    if (file) clues.push({ kind: 'image', value: file, weight: 4 });
  }

  const labelMatch = html.match(/\b(?:aria-label|title|alt)="([^"]{2,})"/i);
  if (labelMatch) clues.push({ kind: 'label', value: labelMatch[1], weight: 3 });

  const forMatch = html.match(/\bfor="([^"]{2,})"/i);
  if (forMatch) clues.push({ kind: 'for', value: stripServerId(forMatch[1]), weight: 3 });

  const nameMatch = html.match(/\bname="([^"]{2,})"/i);
  if (nameMatch) clues.push({ kind: 'name', value: stripServerId(nameMatch[1]), weight: 3 });

  // Unusual (non-Bootstrap) class tokens are decent anchors.
  const classMatch = html.match(/\bclass="([^"]+)"/i);
  if (classMatch) {
    const unusual = classMatch[1].split(/\s+/).filter(isDistinctiveClass);
    if (unusual.length) clues.push({ kind: 'class', value: unusual.join(' '), weight: 2, tokens: unusual });
  }

  // Visible text as a last resort.
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text && text.length >= 4 && text.length <= 60) clues.push({ kind: 'text', value: text, weight: 1 });

  // From CSS-selector target (e.g. "#userGrid > tr:nth-child(2)").
  const targetId = target.match(/#([A-Za-z0-9_\-]{2,})/);
  if (targetId && !clues.some((c) => c.kind === 'id')) clues.push({ kind: 'id', value: stripServerId(targetId[1]), weight: 4 });

  return clues;
}

// ASP.NET WebForms mangles ids like "ctl00_MainContent_btnSave" → search the tail.
// Only applied for WebForms projects: elsewhere `user_name` is a real id.
function stripWebFormsId(id) {
  const parts = id.split(/[_$]/);
  return parts[parts.length - 1] || id;
}

const BOOTSTRAP_PREFIXES = /^(col|row|btn|d-|m[trblxy]?-|p[trblxy]?-|text-|bg-|border|form-|nav|navbar|card|modal|table|badge|alert|container|justify|align|flex|w-|h-|float|fa|fas|far|fab|glyphicon|active|show|collapse|dropdown|input-|rounded|shadow|position-|start-|end-|top-|bottom-)/;
function isDistinctiveClass(cls) {
  if (!cls || cls.length < 3) return false;
  return !BOOTSTRAP_PREFIXES.test(cls);
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Returns a function guessLocations(node) => [{file, line, snippet, clue, confidence}]
 * `repoRoot` is used to display repo-relative paths.
 */
function createMapper(repoPath, extensions, opts = {}) {
  const stripIds = opts.stripServerIds !== false;
  const files = buildIndex(repoPath, extensions);
  const read = makeReader();

  function search(clue, limit = 3, only = null) {
    const needle = clue.kind === 'class' ? clue.tokens[0] : clue.value;
    if (!needle) return [];
    const re = new RegExp(escapeRegExp(needle), 'i');
    const hits = [];
    for (const file of only || files) {
      const lines = read(file);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push({
            file: path.relative(repoPath, file),
            line: i + 1,
            snippet: lines[i].trim().slice(0, 200),
            clue: `${clue.kind}: ${needle}`,
            weight: clue.weight,
          });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  /** Line of the first clue that matches inside one file (runtime gave the file, not the line). */
  function lineInFile(abs, node) {
    for (const clue of cluesFromNode(node, stripIds)) {
      const hit = search(clue, 1, [abs])[0];
      if (hit) return hit;
    }
    return null;
  }

  // Component name → file that defines it (React function/class, Angular/Vue class).
  const defCache = new Map();
  function componentFile(name) {
    if (defCache.has(name)) return defCache.get(name);
    const re = new RegExp(`(?:function|class)\\s+${escapeRegExp(name)}\\b|(?:const|let|var)\\s+${escapeRegExp(name)}\\s*[:=]`);
    let found = null;
    for (const file of files) {
      const lines = read(file);
      const i = lines.findIndex((l) => re.test(l));
      if (i > -1) { found = { abs: file, line: i + 1 }; break; }
    }
    defCache.set(name, found);
    return found;
  }

  function runtimeLocation(node) {
    const rs = node.runtimeSource;
    if (!rs) return null;
    const label = `${rs.framework === 'attr' ? 'source attribute' : rs.framework === 'lint' ? 'ESLint' : rs.framework + ' dev build'}${rs.component ? ` · <${rs.component}>` : ''}`;
    let abs = rs.file ? resolveRuntimeFile(rs.file, repoPath) : null;
    let line = rs.line || null;
    let confidence = abs && line ? (rs.exact ? 'exact' : 'high') : 'medium';

    if (!abs && rs.component) {
      const def = componentFile(rs.component);
      if (!def) return rs.file ? fallback(rs, label) : null;
      abs = def.abs; line = def.line; confidence = 'medium';
      // Angular: the markup is in the component's template file.
      const tpl = (read(abs).join('\n').match(/templateUrl\s*:\s*['"`]([^'"`]+)/) || [])[1];
      if (tpl) {
        const tplAbs = path.resolve(path.dirname(abs), tpl);
        if (fs.existsSync(tplAbs)) { abs = tplAbs; line = null; }
      }
    }
    if (!abs) return fallback(rs, label);

    const lines = read(abs);
    if (line && rs.framework !== 'lint') {
      const settled = settleLine(lines, line, node, rs.zeroBased);
      if (settled.moved && confidence === 'exact') confidence = 'high';
      line = settled.line;
    }
    if (!line) {
      // File known, line not (Vue, Sentry attrs, Angular templates): the
      // element's own tag is a better anchor than text clues, which also hit
      // script code (`const pic = "/x.png"`).
      const tag = ((node.html || '').match(/^<([a-zA-Z][\w.-]*)/) || [])[1];
      const tagged = tag && lines.some((l) => new RegExp(`<${escapeRegExp(tag)}(\\s|>|/|$)`, 'i').test(l));
      if (tagged) line = settleLine(lines, 0, node, false).line;
      else { const hit = lineInFile(abs, node); line = hit ? hit.line : 1; }
    }
    return {
      file: path.relative(repoPath, abs).split(path.sep).join('/'), line,
      snippet: (lines[line - 1] || '').trim().slice(0, 200), clue: label, confidence,
    };
  }

  return {
    indexedFiles: files.length,
    runtimeLocation,
    guessLocations(node) {
      if (!files.length) return [];
      const clues = cluesFromNode(node, stripIds);
      const results = [];
      const seen = new Set();
      for (const clue of clues) {
        for (const hit of search(clue)) {
          const key = `${hit.file}:${hit.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(hit);
        }
        // Stop early once a high-confidence id/image clue lands a hit.
        if (results.length && clue.weight >= 4) break;
      }
      results.sort((a, b) => b.weight - a.weight);
      return results.slice(0, 3).map((r) => ({
        file: r.file, line: r.line, snippet: r.snippet, clue: r.clue,
        confidence: r.weight >= 4 ? 'high' : r.weight >= 3 ? 'medium' : 'low',
      }));
    },
  };
}

/**
 * A file path as a dev build reports it → absolute path inside the repo, or null.
 * Handles absolute paths (built on another machine too), dev-server URLs
 * (http://localhost:5173/src/App.tsx?t=1), Vite's /@fs/, webpack:// URLs.
 */
function resolveRuntimeFile(raw, repoPath) {
  if (!raw || !repoPath) return null;
  let p = String(raw).replace(/[?#].*$/, '');
  p = p.replace(/^webpack:\/\/[^/]*\//, '').replace(/^file:\/\//, '');
  if (/^https?:\/\//.test(p)) { try { p = decodeURIComponent(new URL(p).pathname); } catch { return null; } }
  p = p.replace(/^\/@fs\//, '/').replace(/^\.\//, '');
  if (path.isAbsolute(p) && p.startsWith(repoPath + path.sep) && fs.existsSync(p)) return p;
  // Drop leading segments until the rest exists under the repo:
  // /home/ci/build/app/src/App.tsx → src/App.tsx
  const segs = p.split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const cand = path.join(repoPath, ...segs.slice(i));
    try { if (fs.statSync(cand).isFile()) return cand; } catch { /* keep trimming */ }
  }
  return null;
}

/**
 * Dev-build line numbers are not always the source line: Svelte 4 is 0-based,
 * and Vite's React plugin stamps JSX lines AFTER prepending its hot-reload
 * preamble (~20 lines). Trust the reported line only if it opens the element's
 * tag; otherwise re-anchor on the `<tag` line in that file whose attributes
 * best match the element, nearest the reported line on ties.
 * → { line, moved }
 */
function settleLine(lines, line, node, zeroBased) {
  const html = node.html || '';
  const tag = (html.match(/^<([a-zA-Z][\w.-]*)/) || [])[1];
  const first = zeroBased ? line + 1 : line;
  if (!tag) return { line: first, moved: false };
  const re = new RegExp(`<${escapeRegExp(tag)}(\\s|>|/|$)`, 'i');
  for (const l of zeroBased ? [line + 1, line] : [line, line + 1, line - 1]) {
    if (lines[l - 1] && re.test(lines[l - 1])) return { line: l, moved: false };
  }
  // Attribute values on the element are the anchors (class, src, id, aria-*, …).
  const values = [...html.slice(0, html.indexOf('>') + 1).matchAll(/\s[\w:-]+="([^"]{2,})"/g)].map((m) => m[1]);
  let best = null;
  lines.forEach((text, i) => {
    if (!re.test(text)) return;
    const window = lines.slice(i, i + 4).join(' ');
    const score = values.filter((v) => window.includes(v) || v.split(/\s+/).some((t) => t.length > 2 && window.includes(t))).length;
    const dist = Math.abs(i + 1 - first);
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { line: i + 1, score, dist };
  });
  return best ? { line: best.line, moved: true } : { line: first, moved: false };
}

/** Runtime location when there is no repo to look into: report what the build said. */
function fallback(rs, label) {
  if (!rs.file) return null;
  return { file: String(rs.file).replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+\//, ''), line: rs.line || 1, snippet: '', clue: label, confidence: rs.line ? 'high' : 'medium' };
}

/**
 * All known locations for an axe node, best first: what the running app
 * said (dev builds), then text-search guesses. At most three.
 */
function locateNode(node, mapper) {
  const out = [];
  const rs = node.runtimeSource;
  const rt = mapper ? mapper.runtimeLocation(node) : (rs ? fallback(rs, rs.framework === 'lint' ? 'ESLint' : `${rs.framework} dev build`) : null);
  if (rt) out.push(rt);
  // Lint already knows the exact line; text-search guesses would only add noise.
  if (mapper && !(rs && rs.framework === 'lint')) {
    for (const g of mapper.guessLocations(node)) {
      if (!out.some((o) => o.file === g.file && o.line === g.line)) out.push(g);
    }
  }
  return out.slice(0, 3);
}

module.exports = { createMapper, locateNode, resolveRuntimeFile };
