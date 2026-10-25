/**
 * Regression tests for false positives / negatives in the custom runtime
 * checks — patterns from real design systems (MUI, Angular Material, Ionic,
 * Downshift, asp:Button, Tailwind UI…) that used to be reported as confirmed
 * WCAG failures, and real defects that used to be missed.
 *
 *   node test/fix-c-custom-checks.test.js
 */
const { chromium } = require('playwright');
const { keyboardChecks } = require('../lib/keyboard');
const { clickableChecks, instrumentListeners } = require('../lib/clickable');
const { screenReaderChecks } = require('../lib/screenReader');
const { contrastPixelChecks } = require('../lib/contrastPixel');
const { pointerCancelChecks } = require('../lib/pointerCancel');
const { viewportChecks } = require('../lib/viewport');
const { installGuard } = require('../lib/interact');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };
const targets = (r, kind, id) => (r[kind] || []).filter((x) => !id || x.id === id).flatMap((x) => x.nodes.map((n) => n.target[0]));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const open = async (html) => {
    const p = await ctx.newPage();
    await instrumentListeners(p);
    await p.goto('about:blank');
    await p.setContent(html);
    await p.waitForTimeout(100);
    return p;
  };

  console.log('\n2.4.7 / 2.1.2 — keyboard');
  {
    const p = await open(`<style>
      .mui{outline:0;border:0;background:#1976d2;color:#fff}.mui:focus-visible{background:#0d47a1}
      .wrap{border:2px solid #ccc;display:inline-block}.wrap:focus-within{border-color:#1976d2}.wrap input{outline:none;border:0}
      .overlay{position:relative;outline:none;border:0}.overlay:focus-visible::before{content:"";position:absolute;inset:-3px;border:2px solid #000}
      .raised{box-shadow:0 2px 4px rgba(0,0,0,.3);outline:none;border:0}
      .transparent:focus{outline:2px solid transparent}
      .none:focus{outline:none}
    </style><main>
      <button class="mui">MUI button</button>
      <span class="wrap"><input aria-label="Outlined field"></span>
      <button class="overlay">Material overlay</button>
      <button class="raised">Raised, no focus style</button>
      <button class="transparent">Transparent outline only</button>
      <table>${[1, 2, 3, 4, 5, 6].map((i) => `<tr><td><a class="edit" href="#${i}">Edit</a></td></tr>`).join('')}</table>
      <iframe srcdoc="<a href=#>inside</a>" title="Embedded"></iframe>
      <button class="none" id="last">After the table — no indicator</button>
    </main>`);
    const r = await keyboardChecks(p, { maxTabs: 40 });
    const fv = targets(r, 'violations', 'kbd-focus-visible');
    check(!fv.some((t) => /mui|button:nth-of-type\(1\)/.test(t)), 'MUI background-change focus style is visible');
    check(!fv.some((t) => /input/.test(t)), 'ring on a :focus-within wrapper is visible');
    check(!fv.some((t) => /button:nth-of-type\(2\)$/.test(t)), '::before overlay focus style is visible');
    check(fv.some((t) => /button:nth-of-type\(3\)$/.test(t)), 'resting box-shadow with no change on focus IS flagged');
    check(fv.some((t) => /button:nth-of-type\(4\)$/.test(t)), 'a transparent outline is not a visible indicator');
    check(!fv.some((t) => /iframe/.test(t)), 'iframes are not judged for 2.4.7');
    check(fv.includes('button#last'), 'the walk continues past six identical "Edit" links (no false trap)');
    check(!(r.incomplete || []).some((x) => x.id === 'kbd-keyboard-trap'), 'identical row links are not a keyboard trap');
    await p.close();
  }

  console.log('\n2.1.1 — clickable');
  {
    const p = await open(`<main>
      <button id="dis" disabled>Save</button>
      <a href="#x"><span id="icon" style="display:inline-block;width:16px;height:16px">E</span></a>
      <my-btn id="ce"></my-btn>
      <div aria-hidden="true"><div id="hiddenclick" style="width:20px;height:20px">x</div></div>
      <input role="combobox" aria-controls="lb" aria-expanded="true" aria-activedescendant="o1" aria-label="Fruit">
      <ul role="listbox" id="lb"><li role="option" id="o1">Apple</li><li role="option" id="o2">Pear</li></ul>
      <div id="react1" style="padding:8px">React card</div>
      <div id="react2" style="padding:8px">React card with key handler</div>
      <div id="plain" style="padding:8px">Mouse only</div>
    </main><script>
      customElements.define('my-btn', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML = '<button>Shadow action</button>'; } });
      for (const id of ['dis', 'icon', 'ce', 'hiddenclick', 'plain']) document.getElementById(id).addEventListener('click', () => {});
      const f = () => {};
      document.getElementById('react1').__reactProps$abc = { onClick: f };
      document.getElementById('react2').__reactProps$abc = { onClick: f, onKeyDown: f };
    </script>`);
    const r = await clickableChecks(p);
    const v = targets(r, 'violations', 'kbd-click-not-focusable');
    const roles = targets(r, 'violations', 'kbd-role-not-focusable');
    check(!v.includes('button#dis'), 'a disabled button is not a keyboard gap');
    check(!v.includes('span#icon'), 'an icon inside a link is reached through the link');
    check(!v.includes('my-btn#ce'), 'a web component with a button in its shadow root is reachable');
    check(!v.includes('div#hiddenclick'), 'content inside aria-hidden is not judged');
    check(!roles.some((t) => /o1|o2/.test(t)), 'aria-activedescendant listbox options are not "unfocusable"');
    check(v.includes('div#react1'), 'React 17+ onClick (root-delegated) IS detected via fiber props');
    check(!v.includes('div#react2'), '  a React onClick with onKeyDown is not flagged');
    check(v.includes('div#plain'), 'a plain mouse-only div is still flagged');
    await p.close();
  }

  console.log('\n4.1.2 — screen reader names');
  {
    const p = await open(`<main><form>
      <input type="submit" value="Search" id="sub">
      <input type="submit" id="bare">
      <input type="image" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Go" width="20" height="20" id="img">
      <button id="lbby" aria-labelledby="hid"></button><span id="hid" hidden>Delete row</span>
      <button id="svg"><svg width="16" height="16"><title>Close</title><rect width="16" height="16"/></svg></button>
      </form>
      <button class="icon-btn"></button><button class="icon-btn"></button><button class="icon-btn"></button>
    </main>`);
    const r = await screenReaderChecks(p);
    const un = targets(r, 'violations', 'sr-unnamed-control');
    check(!un.some((t) => /sub|bare|img|lbby|svg/.test(t)),
      'input value / default Submit / image alt / hidden labelledby / svg title all name the control');
    check(un.length === 3, `three distinct unnamed buttons are three findings, not merged (got ${un.length})`);
    await p.close();
  }

  console.log('\n1.4.3 — sampled contrast composites translucent text');
  {
    const p = await open(`<style>body{margin:0}.hero{background:linear-gradient(#fff,#fff);padding:20px}</style>
      <div class="hero"><p id="alpha" style="color:rgba(0,0,0,.38);font-size:14px">Disabled-looking helper text</p>
      <p id="solid" style="color:rgba(0,0,0,.87);font-size:14px">Primary text</p></div>`);
    const r = await contrastPixelChecks(p, ['#alpha', '#solid']);
    const v = targets(r, 'violations');
    check(v.includes('#alpha'), 'rgba(0,0,0,.38) text on white fails (≈2.7:1), not treated as black');
    check(!v.includes('#solid'), 'rgba(0,0,0,.87) text on white passes');
    await p.close();
  }

  console.log('\n2.5.2 — pointer cancellation');
  {
    const p = await open(`<main>
      <div class="swiper" id="sw" style="width:300px;height:80px;background:#eee">Slide 1</div>
      <div id="ticker">0</div>
      <button id="down" style="margin-top:20px">Act on press</button>
    </main><script>
      document.getElementById('sw').addEventListener('pointerdown', () => { document.getElementById('sw').textContent = 'Slide 2 — swiped by a long drag, much longer text here'; });
      let n = 0; setInterval(() => { document.getElementById('ticker').textContent = 'Ticker update number ' + (++n) + ' with some extra text'.repeat(n % 2 + 1); }, 150);
      document.getElementById('down').addEventListener('mousedown', () => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.textContent = 'Opened on press'; document.body.appendChild(d); });
    </script>`);
    const guard = await installGuard(p);
    const r = await pointerCancelChecks(p, { guard });
    await guard.uninstall();
    const v = targets(r, 'violations');
    check(!v.includes('div#sw'), 'a Swiper carousel is exempt (swiping IS the function)');
    check(v.includes('button#down'), 'a dialog opened on mousedown is still caught on a self-changing page');
    await p.close();
  }

  console.log('\n1.4.4 — resize text');
  {
    const p = await open(`<style>
      .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .mobile-only{display:none}@media (max-width:767px){.mobile-only{display:inline-block}}
    </style><header><button class="mobile-only" aria-expanded="false"><span class="sr-only">Open main menu</span>&#9776;</button></header>
    <main><h1>Page</h1><p>Body text</p></main>`);
    const r = await viewportChecks(p, {});
    check(!targets(r, 'violations', 'vp-resize-text').length,
      'a mobile-only hamburger with sr-only text is not "clipped at 200% zoom"');
    await p.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
