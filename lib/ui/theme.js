/**
 * The shared look of every report view: the dashboard, all findings, the fix
 * plan and the single-file bundle. One set of tokens (light + dark), one type
 * face, one icon set, so the views read as one product.
 *
 * Everything is inlined: the font ships with the package (lib/ui/fonts, SIL
 * Open Font License) and is embedded as base64, so reports keep working from
 * file:// with no network.
 *
 * Classes are prefixed `ac-` so they cannot collide with the fix plan's `fp-`
 * classes when both live in the single-file report.
 */
const fs = require('fs');
const path = require('path');

const fontData = (w) => fs.readFileSync(path.join(__dirname, 'fonts', `atkinson-hyperlegible-next-${w}.woff2`)).toString('base64');

// Stroke icons on a 16px grid. Never emoji: they render differently per OS
// and screen readers announce their names.
const ICONS = {
  fail: '<path d="M5 5l6 6M11 5l-6 6"/>',
  pass: '<path d="M3.5 8.5l3 3 6-7"/>',
  auto: '<circle cx="8" cy="8" r="2.2"/>',
  review: '<path d="M8 3.5v6M8 12v.5"/>',
  manual: '<path d="M4 8h8"/>',
  na: '<path d="M4.5 11.5l7-7"/>',
  chev: '<path d="M6 4l4 4-4 4"/>',
  down: '<path d="M4 6l4 4 4-4"/>',
  ext: '<path d="M7 3H3.5v9.5H13V9M9.5 3H13v3.5M13 3L7.5 8.5"/>',
  download: '<path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13h10"/>',
  print: '<path d="M4.5 6V2.5h7V6M4.5 11H3V6h10v5h-1.5M4.5 9h7v4.5h-7z"/>',
  terminal: '<path d="M3 4.5l3.5 3.5L3 11.5M8 12h5"/>',
  keyboard: '<rect x="1.5" y="4" width="13" height="8.5" rx="1.5"/><path d="M4 7h.5M7 7h.5M10 7h.5M12 7h.5M5 10h6"/>',
  ear: '<path d="M4.5 6.5a3.5 3.5 0 117 0c0 2-2 2.5-2 4.5a2 2 0 01-3.5 1.3"/><path d="M6.5 7a1.5 1.5 0 013 0"/>',
  zoom: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5M5.5 7h3M7 5.5v3"/>',
  contrast: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11a5.5 5.5 0 000-11z" fill="currentColor"/>',
  heading: '<path d="M3.5 3v10M10.5 3v10M3.5 8h7"/>',
  repeat: '<path d="M3 6.5A4.5 4.5 0 0111.5 5M13 9.5A4.5 4.5 0 014.5 11"/><path d="M11.5 2.5V5H9M4.5 13.5V11H7"/>',
  form: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5 6h6M5 9h4"/>',
  pointer: '<path d="M5 2.5v8l2.2-2 1.6 3.6 1.6-.7-1.6-3.5H12z"/>',
  code: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6M8 5v.2"/>',
  layers: '<path d="M8 2.5L2.5 5.5 8 8.5l5.5-3z"/><path d="M2.5 8.5L8 11.5l5.5-3"/>',
};
const icon = (name, cls = '') => `<svg class="ac-ic${cls ? ' ' + cls : ''}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;

// Criterion status as the reports show it. `manual` is the internal id for
// "a person has to check this" (no rule exists, or the rules found nothing to judge).
const STATUS_UI = {
  fail: { label: 'Failed', icon: 'fail' },
  review: { label: 'Partial', icon: 'review' },
  pass: { label: 'No automated failures', icon: 'auto' },
  manual: { label: 'Needs a person', icon: 'manual' },
  na: { label: 'Not applicable', icon: 'na' },
};

const TOKENS_LIGHT = `
  --ground:#f4f5f7;--surface:#ffffff;--surface-2:#eef0f3;--surface-3:#e5e8ec;
  --ink:#15202b;--ink-2:#3a4752;--muted:#55636e;--line:#dbe0e5;--line-2:#c3cbd2;
  --link:#0b5fae;--accent:#0b66c3;--accent-ink:#ffffff;--accent-tint:#e5effa;--focus:#0b66c3;
  --mast:#15202b;--mast-ink:#ffffff;--mast-2:#b5c1ca;--mast-line:rgba(255,255,255,.14);
  --fail:#d03b3b;--fail-ink:#ffffff;--fail-text:#a61e1e;--fail-tint:#fbe6e6;
  --good:#0ca30c;--good-ink:#06210a;--good-text:#17692a;--good-tint:#e2f3e2;
  --auto-bg:#e2f3e2;--auto-line:#0ca30c;--auto-ink:#0d3f12;
  --warn:#fab219;--warn-ink:#2b1d00;--warn-text:#7a4a00;--warn-tint:#fdf1d6;
  --un-bg:#e6e9ed;--un-ink:#3a4752;--na-line:#97a3ad;
  --sev-critical:#a61e1e;--sev-critical-bg:#fbe6e6;--sev-serious:#9a3b06;--sev-serious-bg:#fdeadf;
  --sev-moderate:#7a4a00;--sev-moderate-bg:#fdf1d6;--sev-minor:#3a4752;--sev-minor-bg:#e6e9ed;
  --info:#0b5fae;--info-tint:#e5effa;
  --bar:#0b66c3;--bar-2:#9db7d6;--code-bg:#eef0f3;
  --shadow:0 1px 2px rgba(21,32,43,.06),0 4px 14px rgba(21,32,43,.06);
  --shadow-lg:0 12px 36px rgba(21,32,43,.18);color-scheme:light;`;
const TOKENS_DARK = `
  --ground:#0e1418;--surface:#151c21;--surface-2:#1c252b;--surface-3:#243037;
  --ink:#e6ebee;--ink-2:#c2cbd1;--muted:#9eabb4;--line:#28333a;--line-2:#3a4750;
  --link:#7dbdf0;--accent:#5aa8e6;--accent-ink:#0e1418;--accent-tint:#132a3d;--focus:#7dbdf0;
  --mast:#0a0f12;--mast-ink:#ffffff;--mast-2:#a6b3bc;--mast-line:rgba(255,255,255,.12);
  --fail-text:#ffaba5;--fail-tint:#3a1a1a;--good-text:#7fd49b;--good-tint:#14301a;
  --auto-bg:#14301a;--auto-ink:#c8efcf;--warn-text:#f5c97a;--warn-tint:#352713;
  --un-bg:#253037;--un-ink:#c9d2d8;--na-line:#5d6b74;
  --sev-critical:#ffaba5;--sev-critical-bg:#3a1a1a;--sev-serious:#ffbf96;--sev-serious-bg:#3a2214;
  --sev-moderate:#f5c97a;--sev-moderate-bg:#352713;--sev-minor:#c2cbd1;--sev-minor-bg:#253037;
  --info:#7dbdf0;--info-tint:#132a3d;
  --bar:#5aa8e6;--bar-2:#3d5a74;--code-bg:#1c252b;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 14px rgba(0,0,0,.25);--shadow-lg:0 12px 36px rgba(0,0,0,.5);color-scheme:dark;`;

const CSS = `
@font-face{font-family:"AC Hyperlegible";src:url(data:font/woff2;base64,${fontData(400)}) format("woff2");font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:"AC Hyperlegible";src:url(data:font/woff2;base64,${fontData(700)}) format("woff2");font-weight:700;font-style:normal;font-display:swap}
:root{${TOKENS_LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${TOKENS_DARK}}}
:root[data-theme="dark"]{${TOKENS_DARK}}
*,*::before,*::after{box-sizing:border-box}
html{scroll-padding-top:1.5rem;-webkit-text-size-adjust:100%}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
body{margin:0;background:var(--ground);color:var(--ink);font:400 15px/1.55 "AC Hyperlegible",system-ui,-apple-system,"Segoe UI",sans-serif}
::selection{background:var(--accent);color:var(--accent-ink)}
a{color:var(--link);text-underline-offset:.18em;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}
h1,h2,h3,h4{line-height:1.25;text-wrap:balance;margin:0}
p{text-wrap:pretty}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em}
code{background:var(--code-bg);padding:.05em .35em;border-radius:4px;overflow-wrap:anywhere}
pre{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;overflow:auto;margin:.5rem 0;line-height:1.45;color:var(--ink-2)}
pre code{background:none;padding:0}
button{font:inherit;color:inherit}
.vh{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.muted{color:var(--muted)}
.ac-ic{width:1em;height:1em;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;vertical-align:-.125em}
.ac-skip{position:absolute;left:1rem;top:-5rem;z-index:100;background:var(--surface);color:var(--ink);padding:.6rem 1rem;border-radius:8px;box-shadow:var(--shadow-lg)}
.ac-skip:focus{top:1rem}

/* ── Masthead ─────────────────────────────────────────── */
.ac-mast{background:var(--mast);color:var(--mast-ink)}
.ac-mast-in{max-width:1280px;margin:0 auto;padding:1.5rem 1.5rem 0}
.ac-mast-top{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem 2rem;flex-wrap:wrap}
.ac-mast h1{font-size:1.65rem;font-weight:700;letter-spacing:-.01em}
.ac-mast .ac-sub{margin:.35rem 0 0;color:var(--mast-2);font-size:.9rem;overflow-wrap:anywhere}
.ac-mast .ac-sub a{color:var(--mast-ink)}
.ac-mast :focus-visible{outline-color:#fff}
.ac-actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.ac-mast .ac-btn{background:transparent;color:var(--mast-ink);border-color:rgba(255,255,255,.28)}
.ac-mast .ac-btn:hover{background:rgba(255,255,255,.08)}
.ac-facts{display:flex;flex-wrap:wrap;gap:.5rem 0;margin:1.25rem 0 0;padding:1rem 0;border-top:1px solid var(--mast-line)}
.ac-facts div{padding-right:1.75rem;margin-right:1.75rem;border-right:1px solid var(--mast-line)}
.ac-facts div:last-child{border-right:0;margin-right:0}
.ac-facts dt{color:var(--mast-2);font-size:.78rem}
.ac-facts dd{margin:0;font-size:1.3rem;font-weight:700;line-height:1.3}
.ac-facts dd small{font-size:.78rem;font-weight:400;color:var(--mast-2)}
.ac-verdict{display:inline-flex;align-items:center;gap:.45rem;font-weight:700;font-size:.85rem;padding:.3rem .75rem;border-radius:999px;margin-top:.75rem}
.ac-verdict.v-fail{background:var(--fail);color:var(--fail-ink)}
.ac-verdict.v-clean{background:var(--good);color:var(--good-ink)}
.ac-views{display:flex;gap:.25rem;margin:0 -.25rem;overflow-x:auto;scrollbar-width:none}
.ac-views a{display:inline-flex;align-items:center;gap:.4rem;padding:.7rem .9rem .8rem;color:var(--mast-2);text-decoration:none;font-weight:700;font-size:.92rem;border-bottom:3px solid transparent;white-space:nowrap}
.ac-views a:hover{color:var(--mast-ink)}
.ac-views a[aria-current="page"]{color:var(--mast-ink);border-bottom-color:var(--mast-ink)}
.ac-views .count{font-weight:400;color:var(--mast-2);font-size:.82rem}

/* ── Shell: contents rail + main column ───────────────── */
.ac-shell{max-width:1280px;margin:0 auto;padding:0 1.5rem;display:grid;grid-template-columns:14rem minmax(0,1fr);gap:2.5rem}
.ac-toc{position:sticky;top:0;z-index:15;align-self:start;padding:1.75rem 0 2rem}
/* No overflow clipping on the rail: the page picker's list must be able to extend past it. */
.ac-field .a11y-sel{display:block;max-width:none;width:100%}
.ac-field .a11y-sel-list{min-width:100%}
.ac-toc .ac-field{margin-bottom:1.25rem}
.ac-toc p.ac-toc-h{font-size:.78rem;color:var(--muted);font-weight:700;margin:0 0 .4rem}
.ac-toc ol{list-style:none;margin:0;padding:0}
.ac-toc a{display:flex;gap:.55rem;align-items:baseline;padding:.36rem .6rem;margin-left:-.6rem;border-radius:6px;color:var(--ink-2);text-decoration:none;font-size:.9rem}
.ac-toc a .n{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.8rem}
.ac-toc a:hover{background:var(--surface-2);color:var(--ink)}
.ac-toc a[aria-current="true"]{background:var(--accent-tint);color:var(--ink);font-weight:700}
.ac-main{padding:1.75rem 0 5rem;min-width:0}
.ac-sec{margin-bottom:3.25rem}
.ac-sec-h{margin-bottom:1rem}
.ac-sec-h h2{font-size:1.35rem;font-weight:700}
.ac-sec-h p{margin:.35rem 0 0;color:var(--ink-2);max-width:72ch}
.ac-sec h3{font-size:1.02rem;margin:1.75rem 0 .6rem}
.ac-panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:1.1rem 1.25rem}
.ac-panel + .ac-panel{margin-top:1rem}
.ac-grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
.ac-note{display:flex;gap:.75rem;align-items:flex-start;padding:.85rem 1rem;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink-2);font-size:.9rem;margin-bottom:1rem}
.ac-note .ac-ic{width:1.15rem;height:1.15rem;margin-top:.1rem;color:var(--info)}
.ac-note.warn .ac-ic{color:var(--warn-text)}
.ac-note p{margin:0}
.ac-hint{font-size:.85rem;color:var(--muted);margin:.5rem 0 0}
.ac-empty{padding:1.5rem;text-align:center;color:var(--muted);font-size:.92rem}

/* ── Controls ─────────────────────────────────────────── */
.ac-btn{display:inline-flex;align-items:center;gap:.45rem;min-height:2.25rem;padding:.35rem .85rem;border:1px solid var(--line-2);border-radius:8px;background:var(--surface);color:var(--ink);font-size:.88rem;font-weight:700;text-decoration:none;cursor:pointer;white-space:nowrap}
.ac-btn:hover{background:var(--surface-2);text-decoration:none}
.ac-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.ac-btn.primary:hover{filter:brightness(1.08)}
.ac-btn[disabled]{opacity:.5;cursor:not-allowed}
.ac-field{display:grid;gap:.3rem;font-size:.8rem;font-weight:700;color:var(--ink-2)}
.ac-field input,.ac-field select{font:inherit;font-size:.9rem;font-weight:400;color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:8px;padding:.4rem .6rem;min-height:2.4rem;width:100%}
.ac-controls{display:flex;flex-wrap:wrap;gap:.6rem 1rem;align-items:end;margin:0 0 .9rem}
.ac-chips{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center}
.ac-chips .lbl{font-size:.8rem;color:var(--muted);font-weight:700;margin-right:.15rem}
.ac-chip{display:inline-flex;align-items:center;gap:.35rem;min-height:2rem;padding:.2rem .7rem;border:1px solid var(--line-2);border-radius:999px;background:var(--surface);color:var(--ink);font-size:.82rem;cursor:pointer}
.ac-chip:hover{background:var(--surface-2)}
.ac-chip[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--surface)}
.ac-chip b{font-variant-numeric:tabular-nums}
.ac-chip .ac-ic{width:.85rem;height:.85rem;stroke-width:2.4}
.ac-count{font-size:.85rem;color:var(--muted);margin-left:auto;align-self:center}
/* Menu built on <details>: works without JS, closes on Esc/outside click with it. */
.ac-menu{position:relative}
.ac-menu>summary{list-style:none}
.ac-menu>summary::-webkit-details-marker{display:none}
.ac-menu-pop{position:absolute;right:0;top:calc(100% + .35rem);z-index:40;min-width:15rem;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow-lg);padding:.35rem;display:grid}
.ac-menu-pop button{display:flex;align-items:center;gap:.6rem;text-align:left;padding:.55rem .65rem;border:0;border-radius:6px;background:none;color:var(--ink);font-size:.88rem;cursor:pointer}
.ac-menu-pop button:hover,.ac-menu-pop button:focus-visible{background:var(--surface-2)}
.ac-menu-pop small{display:block;color:var(--muted);font-size:.78rem}

/* ── Tables ───────────────────────────────────────────── */
.ac-tbl{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.ac-tbl table{border-collapse:collapse;width:100%;font-size:.88rem}
.ac-tbl th,.ac-tbl td{text-align:left;vertical-align:top;padding:.6rem .85rem;border-top:1px solid var(--line)}
.ac-tbl thead th{border-top:0;font-size:.78rem;color:var(--muted);font-weight:700;white-space:nowrap;background:var(--surface)}
.ac-tbl tbody th{font-weight:700}
.ac-tbl .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ac-tbl .ctr{text-align:center}
.ac-tbl tr.grp th{background:var(--surface-2);font-size:.8rem;color:var(--ink-2);padding:.4rem .85rem}
.ac-tbl thead th button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;display:inline-flex;gap:.3rem;align-items:center}
.ac-tbl thead th button::after{content:"↕";opacity:.45}
.ac-tbl thead th[aria-sort] button{color:var(--ink)}
.ac-tbl thead th[aria-sort="ascending"] button::after{content:"↑";opacity:1}
.ac-tbl thead th[aria-sort="descending"] button::after{content:"↓";opacity:1}
.ac-tbl tr:target{background:var(--accent-tint)}
.ac-zero{color:var(--line-2)}

/* ── Status, severity, tiles ──────────────────────────── */
.ac-st{display:inline-flex;align-items:center;gap:.3rem;font-size:.75rem;font-weight:700;padding:.1rem .55rem;border-radius:999px;white-space:nowrap}
.ac-st .ac-ic{width:.8rem;height:.8rem;stroke-width:2.6}
.st-fail{background:var(--fail);color:var(--fail-ink)}
.st-review{background:var(--warn);color:var(--warn-ink)}
.st-pass{background:var(--auto-bg);color:var(--auto-ink);box-shadow:inset 0 0 0 1px var(--auto-line)}
.st-verified{background:var(--good);color:var(--good-ink)}
.st-manual{background:var(--un-bg);color:var(--un-ink)}
.st-na{color:var(--muted);box-shadow:inset 0 0 0 1px var(--na-line)}
.ac-sev{display:inline-flex;align-items:center;font-size:.75rem;font-weight:700;padding:.1rem .55rem;border-radius:999px;white-space:nowrap;text-transform:capitalize}
.ac-sev.nocap{text-transform:none}
.sev-critical{background:var(--sev-critical-bg);color:var(--sev-critical)}
.sev-serious{background:var(--sev-serious-bg);color:var(--sev-serious)}
.sev-moderate{background:var(--sev-moderate-bg);color:var(--sev-moderate)}
.sev-minor{background:var(--sev-minor-bg);color:var(--sev-minor)}
.ac-tag{display:inline-flex;align-items:center;gap:.3rem;font-size:.75rem;font-weight:700;padding:.1rem .55rem;border-radius:999px;border:1px solid var(--line-2);color:var(--ink-2);white-space:nowrap;text-decoration:none;font-variant-numeric:tabular-nums}
a.ac-tag:hover{border-color:var(--link);color:var(--link)}
.ac-map{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem 1.5rem}
.ac-map h3{font-size:.82rem;color:var(--muted);margin:0 0 .5rem}
.ac-map ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px}
.ac-tile{display:inline-flex;align-items:center;gap:3px;height:28px;min-width:3.3rem;padding:0 6px;border-radius:5px;border:1px solid transparent;font-size:.76rem;font-weight:700;font-variant-numeric:tabular-nums;text-decoration:none;cursor:pointer;font-family:inherit}
.ac-tile .ac-ic{width:.82rem;height:.82rem;stroke-width:2.4}
.ac-tile.t-fail,.cell.t-fail{background:var(--fail);color:var(--fail-ink)}
.ac-tile.t-review,.cell.t-review{background:var(--warn);color:var(--warn-ink)}
.ac-tile.t-pass,.cell.t-pass{background:var(--auto-bg);color:var(--auto-ink);border-color:var(--auto-line)}
.ac-tile.t-manual,.cell.t-manual{background:var(--un-bg);color:var(--un-ink)}
.ac-tile.t-na,.cell.t-na{background:transparent;color:var(--muted);border:1px dashed var(--na-line)}
.ac-tile:hover{box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--line-2)}
.ac-tile.dim{opacity:.28}
.ac-key{list-style:none;margin:1rem 0 0;padding:.85rem 0 0;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:.45rem 1.5rem;font-size:.82rem;color:var(--ink-2)}
.ac-key li{display:flex;align-items:center;gap:.45rem}
.ac-key b{color:var(--ink);font-variant-numeric:tabular-nums}
.ac-key .ac-tile{min-width:1.6rem;height:1.2rem;justify-content:center;padding:0;cursor:default}

/* ── Bar list (one series: no legend, value at the tip) ── */
.ac-bars{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.ac-bars li{display:grid;grid-template-columns:minmax(8rem,14rem) minmax(0,1fr);align-items:center;gap:.75rem;font-size:.84rem;color:var(--ink-2)}
.ac-bars .lab{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-bars .trk{display:flex;align-items:center;gap:.45rem;height:22px;border-left:1px solid var(--line-2)}
.ac-bars .bar{display:block;height:14px;min-width:3px;background:var(--bar);border-radius:0 4px 4px 0}
.ac-bars .val{font-size:.8rem;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
.ac-mini{display:inline-block;vertical-align:middle;height:8px;min-width:2px;background:var(--bar);border-radius:0 3px 3px 0;margin-right:.45rem}

/* ── Disclosure ───────────────────────────────────────── */
.ac-disc{background:var(--surface);border:1px solid var(--line);border-radius:12px}
.ac-disc + .ac-disc{margin-top:.6rem}
.ac-disc>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:.75rem;padding:.85rem 1.1rem;border-radius:12px;font-weight:700}
.ac-disc>summary::-webkit-details-marker{display:none}
.ac-disc>summary .ac-ic.chev{margin-left:auto;color:var(--muted);transition:transform .18s ease-out}
.ac-disc[open]>summary .ac-ic.chev{transform:rotate(90deg)}
.ac-disc>summary .sum-sub{font-weight:400;color:var(--muted);font-size:.86rem}
.ac-disc-body{padding:0 1.1rem 1.1rem;border-top:1px solid var(--line)}
.ac-disc-body>:first-child{margin-top:1rem}

/* ── Contrast chip: the measured pair, rendered ───────── */
.ac-sw{display:inline-flex;align-items:stretch;border:1px solid var(--line-2);border-radius:8px;overflow:hidden;background:var(--surface);font-size:.78rem;vertical-align:middle}
.ac-sw-s{display:flex;align-items:center;padding:.3rem .6rem;font-weight:700;font-size:.88rem;max-width:10rem;white-space:nowrap;overflow:hidden}
.ac-sw-s::before{content:attr(data-s);overflow:hidden;text-overflow:ellipsis}
.ac-sw-m{display:grid;grid-template-columns:auto auto;align-items:center;column-gap:.3rem;padding:.2rem .55rem;line-height:1.3}
.ac-sw-m b{color:var(--fail-text)}
.ac-sw-m .ac-ic{color:var(--fail-text);width:.8rem;height:.8rem;stroke-width:2.6}
.ac-sw-m .hex{grid-column:1/-1;font:400 .68rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}

/* ── Dialog + tooltip ─────────────────────────────────── */
.ac-dlg{width:min(940px,calc(100vw - 32px));max-height:calc(100vh - 48px);padding:0;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-lg);overflow:auto;background:var(--surface);color:var(--ink)}
.ac-dlg::backdrop{background:rgba(10,15,18,.5)}
.ac-dlg-head{position:sticky;top:0;z-index:1;background:var(--surface);display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:1rem 1.25rem;border-bottom:1px solid var(--line)}
.ac-dlg-head h2{font-size:1.05rem}
.ac-dlg-x{flex:none;width:2.25rem;height:2.25rem;border:1px solid var(--line-2);border-radius:8px;background:var(--surface);cursor:pointer;display:grid;place-items:center}
.ac-dlg-x:hover{background:var(--surface-2)}
.ac-dlg-body{padding:1rem 1.25rem}
.ac-tip{position:fixed;z-index:80;pointer-events:none;background:var(--ink);color:var(--surface);font-size:.8rem;line-height:1.4;padding:.4rem .6rem;border-radius:6px;max-width:22rem;box-shadow:var(--shadow-lg);opacity:0;transition:opacity .12s ease-out}
.ac-tip.on{opacity:1}

/* ── Issue card (findings view + dialog) ──────────────── */
.ac-issue{background:var(--surface);border:1px solid var(--line);border-radius:12px;margin-bottom:.6rem}
.ac-issue[open]{box-shadow:var(--shadow);border-color:var(--line-2)}
.ac-issue>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.35rem 1rem;padding:.9rem 1.1rem;border-radius:12px}
.ac-issue>summary::-webkit-details-marker{display:none}
.ac-issue>summary:hover .ac-issue-t{color:var(--link)}
.ac-issue-t{font-weight:700;font-size:1rem}
.ac-issue-m{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;font-size:.8rem;color:var(--muted)}
.ac-issue-r{grid-row:1/3;grid-column:2;text-align:right;font-size:.82rem;color:var(--muted);white-space:nowrap;display:flex;align-items:center;gap:.6rem}
.ac-issue-r b{color:var(--ink);font-variant-numeric:tabular-nums}
.ac-issue-r .ac-ic{color:var(--muted);transition:transform .18s ease-out}
.ac-issue[open] .ac-issue-r .ac-ic{transform:rotate(90deg)}
.ac-issue-b{border-top:1px solid var(--line);padding:1rem 1.1rem 1.1rem;display:grid;gap:.9rem}
.ac-issue-b .ac-lbl{font-size:.8rem;font-weight:700;color:var(--muted);margin:0 0 .3rem}
.ac-fix{background:var(--good-tint);border:1px solid var(--line);border-radius:10px;padding:.7rem .9rem;color:var(--ink)}
.ac-fix .ac-lbl{color:var(--good-text)}
.ac-loc{background:var(--info-tint);border-radius:8px;padding:.5rem .7rem;font-size:.84rem;margin-top:.35rem}
.ac-loc pre{margin:.4rem 0 0}
.ac-inst{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}
.ac-inst>li{border:1px solid var(--line);border-radius:10px;padding:.6rem .75rem;background:var(--surface)}
.ac-inst-h{display:flex;flex-wrap:wrap;gap:.35rem .6rem;align-items:baseline;font-size:.84rem}
.ac-inst-h b{color:var(--ink)}
.ac-inst-sel{font-size:.76rem;color:var(--muted);overflow-wrap:anywhere;margin-top:.15rem}
.ac-inst pre{max-height:7rem;margin:.4rem 0 0;white-space:pre-wrap;word-break:break-all}
.ac-shot{display:block;max-width:100%;border:1px solid var(--line);border-radius:6px;margin:.5rem 0 0}
.ac-more{margin-top:.35rem}

/* ── Responsive ───────────────────────────────────────── */
@media (max-width:1000px){
  .ac-shell{grid-template-columns:minmax(0,1fr);gap:0}
  .ac-toc{position:sticky;top:0;z-index:20;margin:0 -1.5rem;padding:.5rem 1.5rem;background:color-mix(in srgb,var(--ground) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);display:flex;gap:1rem;align-items:center}
  .ac-toc .ac-field{margin:0;flex:none;width:12rem}
  .ac-toc .ac-field>.lbl-t{display:none}
  .ac-toc p.ac-toc-h{display:none}
  .ac-toc ol{display:flex;gap:.2rem;overflow-x:auto;scrollbar-width:none}
  .ac-toc a{white-space:nowrap;margin:0}
  .ac-toc a .n{display:none}
  html{scroll-padding-top:4.5rem}
  .ac-map{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ac-grid-2{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:700px){
  .ac-mast-in{padding:1.25rem 1rem 0}
  .ac-facts{display:grid;grid-template-columns:1fr 1fr;gap:.75rem 1rem}
  .ac-facts div{padding:0;margin:0;border:0}
  .ac-shell{padding:0 1rem}
  .ac-toc{margin:0 -1rem;padding:.5rem 1rem;flex-wrap:wrap}
  .ac-toc .ac-field{width:100%}
  .ac-bars li{grid-template-columns:7.5rem minmax(0,1fr)}
  .ac-issue>summary{grid-template-columns:minmax(0,1fr)}
  .ac-issue-r{grid-row:auto;grid-column:auto;justify-content:flex-start}
  .ac-tbl th,.ac-tbl td{padding:.55rem .6rem}
  .hide-sm{display:none}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
@media (forced-colors:active){.ac-tile,.ac-st,.ac-sev,.ac-verdict,.ac-chip[aria-pressed="true"]{border:1px solid CanvasText}.ac-bars .bar,.ac-mini{background:CanvasText}}
@media print{
  body{background:#fff}
  .ac-toc,.ac-actions,.ac-skip,.ac-tip,.ac-controls,.ac-views{display:none!important}
  .ac-shell{display:block;padding:0}
  .ac-mast{background:#fff;color:#000;border-bottom:2px solid #000}
  .ac-mast .ac-sub,.ac-facts dt,.ac-facts dd small{color:#333}
  .ac-panel,.ac-disc,.ac-issue,.ac-tbl{box-shadow:none;break-inside:avoid}
  *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
}
`;

/**
 * The tooltip, contents-rail tracking and <details>-menu behaviour shared by
 * the views. Plain ES5 so it runs in any browser that opens a file:// report.
 */
const SCRIPT = `<script>(function(){
  if(window.__acUi)return;window.__acUi=1;
  var tip=document.createElement('div');tip.className='ac-tip';tip.setAttribute('aria-hidden','true');document.body.appendChild(tip);
  function show(el){var t=el.getAttribute('data-tip');if(!t)return;tip.textContent=t;tip.classList.add('on');var r=el.getBoundingClientRect(),w=tip.offsetWidth,h=tip.offsetHeight;
    tip.style.left=Math.max(8,Math.min(innerWidth-w-8,r.left+r.width/2-w/2))+'px';tip.style.top=(r.top-h-8<8?r.bottom+8:r.top-h-8)+'px';}
  function hide(){tip.classList.remove('on');}
  document.addEventListener('mouseover',function(e){var el=e.target.closest&&e.target.closest('[data-tip]');if(el)show(el);else hide();});
  document.addEventListener('focusin',function(e){var el=e.target.closest&&e.target.closest('[data-tip]');if(el)show(el);else hide();});
  addEventListener('scroll',hide,{passive:true});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){hide();[].forEach.call(document.querySelectorAll('details.ac-menu[open]'),function(d){d.open=false;var s=d.querySelector('summary');if(s)s.focus();});}});
  document.addEventListener('click',function(e){[].forEach.call(document.querySelectorAll('details.ac-menu[open]'),function(d){if(!d.contains(e.target))d.open=false;});});
  // Contents rail: mark the section in view. Re-run with __acToc() when a view becomes visible.
  window.__acToc=function(){
    [].forEach.call(document.querySelectorAll('.ac-toc'),function(toc){
      if(toc.__io||!('IntersectionObserver' in window))return;
      var links=[].slice.call(toc.querySelectorAll('a[href^="#"]'));
      var io=new IntersectionObserver(function(es){es.forEach(function(en){if(!en.isIntersecting)return;
        links.forEach(function(a){var on=a.getAttribute('href')==='#'+en.target.id;a.setAttribute('aria-current',String(on));
          if(on){var ol=a.closest('ol');if(ol&&ol.scrollWidth>ol.clientWidth)ol.scrollLeft=a.offsetLeft-ol.clientWidth/2+a.offsetWidth/2;}});});},{rootMargin:'-15% 0px -75% 0px'});
      links.forEach(function(a){var t=document.getElementById(a.getAttribute('href').slice(1));if(t)io.observe(t);});toc.__io=io;});
  };
  window.__acToc();
})();</script>`;

module.exports = { CSS, SCRIPT, ICONS, icon, STATUS_UI };
