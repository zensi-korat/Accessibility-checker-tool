/**
 * Best-effort mapping of a live DOM violation back to source code.
 *
 * Runtime HTML (Razor/.aspx) rarely matches source 1:1, so we extract the
 * strongest, most unique clues from the offending element and grep the repo:
 *   id  >  image filename  >  aria-label/title  >  unusual class combo  >  text
 * Returns ranked {file, line, snippet, clue} guesses. It gets you close;
 * it is not a guaranteed exact line.
 *
 * Confidence is earned, not assumed: tokens are matched on word boundaries
 * (and ids/names in attribute position first), a clue that matches in more
 * than one file is downgraded and says how many, short ids are weak, and a
 * bare component name (production React: no _debugSource) is never used to
 * pick a file.
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

  /** Regexes for a clue: attribute-position first (id="x", htmlFor={'x'}, id: 'x'), then the bare word. */
  function patterns(clue, needle) {
    const e = escapeRegExp(needle);
    const wordy = /^\w/.test(needle) && /\w$/.test(needle);
    const bare = new RegExp(wordy ? `(?<![\\w-])${e}(?![\\w-])` : e, 'i');
    if (clue.kind === 'id' || clue.kind === 'for' || clue.kind === 'name') {
      const attr = clue.kind === 'name' ? 'name' : clue.kind === 'for' ? '(?:for|htmlFor)' : '(?:id|ID|\\[id\\]|:id)';
      return [new RegExp(`\\b${attr}\\s*[=:]\\s*\\{?\\s*["'\x60]${e}["'\x60]`), bare];
    }
    return [bare];
  }

  /**
   * Hits for one clue, at most `limit`, plus how many distinct files matched
   * (scanned up to `fileCap`) — a clue found in many files is not a location.
   */
  function searchAll(clue, limit = 3, only = null, fileCap = 25) {
    const needle = clue.kind === 'class' ? clue.tokens[0] : clue.value;
    if (!needle) return { hits: [], files: 0 };
    for (const re of patterns(clue, needle)) {
      const hits = [];
      const matched = new Set();
      for (const file of only || files) {
        const lines = read(file);
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          matched.add(file);
          if (hits.length < limit) {
            hits.push({
              file: path.relative(repoPath, file),
              line: i + 1,
              snippet: lines[i].trim().slice(0, 200),
              clue: `${clue.kind}: ${needle}`,
              weight: clue.weight,
            });
          }
        }
        if (matched.size >= fileCap && hits.length >= limit) break;
      }
      if (hits.length) return { hits, files: matched.size };
    }
    return { hits: [], files: 0 };
  }
  const search = (clue, limit = 3, only = null) => searchAll(clue, limit, only).hits;

  /** Line of the first clue that matches inside one file (runtime gave the file, not the line). */
  function lineInFile(abs, node) {
    for (const clue of cluesFromNode(node, stripIds)) {
      const hit = search(clue, 1, [abs])[0];
      if (hit) return hit;
    }
    return null;
  }

  // Component name → file that defines it (React function/class, Angular/Vue class).
  // → { abs, line, files } (files = how many files define that name) | null
  const defCache = new Map();
  function componentFile(name) {
    // Minified names (t, e, Xn) match unrelated variables.
    if (!name || name.length < 3 || !/^[A-Z_$]/.test(name) || /^[A-Za-z]\d*$/.test(name)) return null;
    if (defCache.has(name)) return defCache.get(name);
    const re = new RegExp(`(?:function|class)\\s+${escapeRegExp(name)}\\b|(?:const|let|var)\\s+${escapeRegExp(name)}\\s*[:=]`);
    let found = null;
    for (const file of files) {
      const lines = read(file);
      const i = lines.findIndex((l) => re.test(l));
      if (i < 0) continue;
      if (found) { found.files++; continue; }
      found = { abs: file, line: i + 1, files: 1 };
    }
    defCache.set(name, found);
    return found;
  }

  // Basename → how many indexed files share it (index.tsx, page.tsx, App.vue…).
  let byBase = null;
  const sameBasename = (abs) => {
    if (!byBase) { byBase = new Map(); for (const f of files) { const b = path.basename(f).toLowerCase(); byBase.set(b, (byBase.get(b) || 0) + 1); } }
    return byBase.get(path.basename(abs).toLowerCase()) || 0;
  };

  function runtimeLocation(node) {
    const rs = node.runtimeSource;
    if (!rs) return null;
    const label = `${rs.framework === 'attr' ? 'source attribute' : rs.framework === 'lint' ? 'ESLint' : rs.framework + ' dev build'}${rs.component ? ` · <${rs.component}>` : ''}`;
    const resolved = rs.file ? resolveRuntimeFileInfo(rs.file, repoPath) : null;
    let abs = resolved ? resolved.abs : null;
    let line = rs.line || null;
    let confidence = abs && line ? (rs.exact ? 'exact' : 'high') : 'medium';
    // Only the bare filename matched (the build's directories don't exist here):
    // fine if that name is unique in the repo, a guess if not.
    if (resolved && resolved.basenameOnly) confidence = sameBasename(abs) > 1 ? 'low' : 'medium';

    // A component name alone (production React keeps fiber names but strips
    // _debugSource) is a hint, not a location — leave it to the text search.
    if (!abs && rs.component && !rs.nameOnly) {
      const def = componentFile(rs.component);
      if (!def) return rs.file ? fallback(rs, label) : null;
      abs = def.abs; line = def.line; confidence = def.files > 1 ? 'low' : 'medium';
      // Angular: the markup is in the component's template file.
      const tpl = (read(abs).join('\n').match(/templateUrl\s*:\s*['"`]([^'"`]+)/) || [])[1];
      if (tpl) {
        const tplAbs = path.resolve(path.dirname(abs), tpl);
        if (fs.existsSync(tplAbs)) { abs = tplAbs; line = null; }
      }
    }
    // The build named a file this checkout doesn't have: show it, don't vouch for it.
    if (!abs) { const fb = fallback(rs, label); return fb && repoPath ? { ...fb, confidence: 'low' } : fb; }

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
        const { hits, files: spread } = searchAll(clue);
        for (const hit of hits) {
          const key = `${hit.file}:${hit.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ ...hit, confidence: clueConfidence(clue, spread), spread });
        }
        // Stop early once a strong, unambiguous id/image clue lands a hit.
        if (results.length && clue.weight >= 4 && spread === 1) break;
      }
      const rank = { high: 3, medium: 2, low: 1 };
      results.sort((a, b) => rank[b.confidence] - rank[a.confidence] || b.weight - a.weight);
      return results.slice(0, 3).map((r) => ({
        file: r.file, line: r.line, snippet: r.snippet,
        clue: r.spread > 1 ? `${r.clue} (matches ${r.spread >= 25 ? '25+' : r.spread} files)` : r.clue,
        confidence: r.confidence,
      }));
    },
  };
}

/**
 * How far a text-search hit can be trusted.
 *   id/for/name: high only when long enough to be distinctive (≥ 4 chars)
 *   image filename: medium at most (the same logo is referenced everywhere)
 *   one step down for each spread: 2+ files → -1, 5+ files → -2
 */
function clueConfidence(clue, spread) {
  const levels = ['low', 'medium', 'high'];
  let lvl = clue.weight >= 4 ? 2 : clue.weight >= 3 ? 1 : 0;
  if (clue.kind === 'image') lvl = Math.min(lvl, 1);
  if ((clue.kind === 'id' || clue.kind === 'for' || clue.kind === 'name') && String(clue.value).length < 4) lvl = 0;
  if (spread > 1) lvl -= 1;
  if (spread >= 5) lvl -= 1;
  return levels[Math.max(0, lvl)];
}

/**
 * A file path as a dev build reports it → absolute path inside the repo, or null.
 * Handles absolute paths (built on another machine too), dev-server URLs
 * (http://localhost:5173/src/App.tsx?t=1), Vite's /@fs/, webpack:// URLs.
 */
function resolveRuntimeFile(raw, repoPath) {
  const r = resolveRuntimeFileInfo(raw, repoPath);
  return r ? r.abs : null;
}

/** Same as resolveRuntimeFile, plus whether only the bare filename matched. → { abs, basenameOnly } | null */
function resolveRuntimeFileInfo(raw, repoPath) {
  if (!raw || !repoPath) return null;
  let p = String(raw).replace(/[?#].*$/, '');
  p = p.replace(/^webpack:\/\/[^/]*\//, '').replace(/^file:\/\//, '');
  if (/^https?:\/\//.test(p)) { try { p = decodeURIComponent(new URL(p).pathname); } catch { return null; } }
  p = p.replace(/^\/@fs\//, '/').replace(/^\.\//, '');
  if (path.isAbsolute(p) && p.startsWith(repoPath + path.sep) && fs.existsSync(p)) return { abs: p, basenameOnly: false };
  // Drop leading segments until the rest exists under the repo:
  // /home/ci/build/app/src/App.tsx → src/App.tsx
  const segs = p.split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const cand = path.join(repoPath, ...segs.slice(i));
    try { if (fs.statSync(cand).isFile()) return { abs: cand, basenameOnly: segs.length > 1 && i === segs.length - 1 }; } catch { /* keep trimming */ }
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

module.exports = { createMapper, locateNode, resolveRuntimeFile, resolveRuntimeFileInfo, _internal: { clueConfidence } };
