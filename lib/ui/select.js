/* Accessible custom select — WAI-ARIA APG "select-only combobox".
 *
 * Progressive enhancement: the native <select> stays in the DOM as the source
 * of truth (hidden from view and from assistive tech). Code that reads
 * select.value, sets it, or listens for 'change' keeps working unchanged.
 *
 *   A11ySelect.enhance(selectEl)        one element
 *   <select data-a11y-select>           enhanced automatically on load
 *
 * Keyboard (as the APG pattern): closed — ↓ ↑ Enter Space Alt+↓ open, Home/End
 * open at the ends, typing jumps to a match. Open — ↓ ↑ Home End PageUp
 * PageDown move, Enter/Space/Alt+↑ choose and close, Tab chooses and moves on,
 * Escape closes without changing, typing jumps to a match.
 *
 * Loaded once per page even if several fragments include it (the single-file
 * report contains both the dashboard and the fix plan).
 */
(function () {
  'use strict';
  function whenReady(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
  // A second copy (the single-file report holds two pages) only enhances what is new.
  if (window.A11ySelect) { whenReady(function () { window.A11ySelect.enhanceAll(); }); return; }
  var uid = 0;
  var nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  var nativeIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

  function labelFor(sel) {
    if (sel.getAttribute('aria-label')) return sel.getAttribute('aria-label');
    var l = sel.id && document.querySelector('label[for="' + sel.id + '"]');
    if (!l) l = sel.closest('label');
    if (!l) return '';
    var c = l.cloneNode(true);
    c.querySelectorAll('select,.a11y-sel').forEach(function (n) { n.remove(); });
    return c.textContent.replace(/\s+/g, ' ').replace(/:\s*$/, '').trim();
  }

  function enhance(sel) {
    if (!sel || sel.__a11ySel || sel.tagName !== 'SELECT' || sel.multiple) return sel && sel.__a11ySel;
    var id = 'a11y-sel-' + (++uid);
    var wrap = document.createElement('div');
    wrap.className = 'a11y-sel';
    var combo = document.createElement('div');
    combo.className = 'a11y-sel-combo';
    combo.id = id;
    combo.tabIndex = 0;
    combo.setAttribute('role', 'combobox');
    combo.setAttribute('aria-haspopup', 'listbox');
    combo.setAttribute('aria-expanded', 'false');
    combo.setAttribute('aria-controls', id + '-list');
    var label = labelFor(sel);
    if (label) combo.setAttribute('aria-label', label);
    var text = document.createElement('span');
    text.className = 'a11y-sel-value';
    combo.appendChild(text);
    combo.insertAdjacentHTML('beforeend', '<svg class="a11y-sel-caret" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>');
    var list = document.createElement('ul');
    list.className = 'a11y-sel-list';
    list.id = id + '-list';
    list.setAttribute('role', 'listbox');
    if (label) list.setAttribute('aria-label', label);
    list.tabIndex = -1;
    list.hidden = true;

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(combo);
    wrap.appendChild(list);
    wrap.appendChild(sel);
    sel.classList.add('a11y-sel-native');
    sel.setAttribute('aria-hidden', 'true');
    sel.tabIndex = -1;

    // Clicking a <label for> focuses the custom control instead of the hidden one.
    if (sel.id) {
      document.querySelectorAll('label[for="' + sel.id + '"]').forEach(function (l) {
        l.addEventListener('click', function (e) { e.preventDefault(); combo.focus(); });
      });
    }

    var open = false, active = -1, typed = '', typedAt = 0;
    function opts() { return [].slice.call(sel.options); }
    function enabled(i) { var o = sel.options[i]; return o && !o.disabled; }

    function sync() {
      var o = sel.options[nativeIndex.get.call(sel)];
      text.textContent = o ? o.text : '';
      combo.setAttribute('aria-disabled', sel.disabled ? 'true' : 'false');
      combo.tabIndex = sel.disabled ? -1 : 0;
    }
    function build() {
      var cur = nativeIndex.get.call(sel);
      list.innerHTML = '';
      opts().forEach(function (o, i) {
        var li = document.createElement('li');
        li.id = id + '-opt-' + i;
        li.className = 'a11y-sel-opt';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', i === cur ? 'true' : 'false');
        if (o.disabled) li.setAttribute('aria-disabled', 'true');
        li.innerHTML = '<svg class="a11y-sel-check" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
        var span = document.createElement('span');
        span.textContent = o.text;
        li.appendChild(span);
        li.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus on the combobox
        li.addEventListener('click', function () { if (!o.disabled) { choose(i); close(); } });
        li.addEventListener('mousemove', function () { if (active !== i && !o.disabled) setActive(i, false); });
        list.appendChild(li);
      });
    }
    function setActive(i, scroll) {
      var items = list.children;
      if (items[active]) items[active].classList.remove('is-active');
      active = i;
      if (items[i]) {
        items[i].classList.add('is-active');
        combo.setAttribute('aria-activedescendant', items[i].id);
        if (scroll !== false) {
          var it = items[i];
          if (it.offsetTop < list.scrollTop) list.scrollTop = it.offsetTop;
          else if (it.offsetTop + it.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = it.offsetTop + it.offsetHeight - list.clientHeight;
        }
      }
    }
    function place() {
      // Open upwards when there isn't room below.
      var r = combo.getBoundingClientRect();
      var below = window.innerHeight - r.bottom, above = r.top;
      wrap.classList.toggle('is-up', below < Math.min(280, list.scrollHeight + 12) && above > below);
    }
    function openList(at) {
      if (open || sel.disabled) return;
      build();
      open = true;
      list.hidden = false;
      combo.setAttribute('aria-expanded', 'true');
      wrap.classList.add('is-open');
      place();
      var cur = nativeIndex.get.call(sel);
      setActive(at != null ? at : (cur < 0 ? 0 : cur));
      document.addEventListener('mousedown', outside, true);
    }
    function close() {
      if (!open) return;
      open = false;
      list.hidden = true;
      combo.setAttribute('aria-expanded', 'false');
      combo.removeAttribute('aria-activedescendant');
      wrap.classList.remove('is-open', 'is-up');
      document.removeEventListener('mousedown', outside, true);
    }
    function outside(e) { if (!wrap.contains(e.target)) close(); }
    function choose(i) {
      if (i < 0 || !enabled(i)) return;
      var changed = nativeIndex.get.call(sel) !== i;
      nativeIndex.set.call(sel, i);
      sync();
      if (changed) {
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    function step(from, dir) {
      var n = sel.options.length, i = from;
      for (var k = 0; k < n; k++) { i += dir; if (i < 0 || i >= n) return from; if (enabled(i)) return i; }
      return from;
    }
    function first() { return step(-1, 1); }
    function last() { return step(sel.options.length, -1); }
    function match(ch) {
      var now = Date.now();
      typed = (now - typedAt > 700 ? '' : typed) + ch.toLowerCase();
      typedAt = now;
      var n = sel.options.length, start = open ? active : nativeIndex.get.call(sel);
      // Repeating one letter cycles through items starting with it.
      var q = typed.split('').every(function (c) { return c === typed[0]; }) ? typed[0] : typed;
      var from = q.length === 1 ? start + 1 : start;
      for (var k = 0; k < n; k++) {
        var i = (from + k + n) % n;
        if (enabled(i) && sel.options[i].text.trim().toLowerCase().indexOf(q) === 0) return i;
      }
      return -1;
    }

    combo.addEventListener('click', function () { if (open) close(); else openList(); });
    combo.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== combo) close(); }, 0); });
    combo.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k.length !== 1) typed = ''; // navigation keys end a type-ahead run
      if (!open) {
        if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); openList(); return; }
        if (k === 'Home') { e.preventDefault(); openList(first()); return; }
        if (k === 'End') { e.preventDefault(); openList(last()); return; }
        if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { var m0 = match(k); if (m0 > -1) { e.preventDefault(); choose(m0); } }
        return;
      }
      if (k === 'ArrowDown' && !e.altKey) { e.preventDefault(); setActive(step(active, 1)); }
      else if (k === 'ArrowUp' && e.altKey) { e.preventDefault(); choose(active); close(); }
      else if (k === 'ArrowUp') { e.preventDefault(); setActive(step(active, -1)); }
      else if (k === 'Home') { e.preventDefault(); setActive(first()); }
      else if (k === 'End') { e.preventDefault(); setActive(last()); }
      else if (k === 'PageDown') { e.preventDefault(); var d = active; for (var a = 0; a < 10; a++) d = step(d, 1); setActive(d); }
      else if (k === 'PageUp') { e.preventDefault(); var u = active; for (var b = 0; b < 10; b++) u = step(u, -1); setActive(u); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(active); close(); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (k === 'Tab') { choose(active); close(); }
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { var m = match(k); if (m > -1) { e.preventDefault(); setActive(m); } }
    });

    // Programmatic changes (sel.value = 'x' / selectedIndex) refresh the display.
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get: function () { return nativeValue.get.call(sel); },
      set: function (v) { nativeValue.set.call(sel, v); sync(); if (open) build(); },
    });
    Object.defineProperty(sel, 'selectedIndex', {
      configurable: true,
      get: function () { return nativeIndex.get.call(sel); },
      set: function (v) { nativeIndex.set.call(sel, v); sync(); if (open) build(); },
    });
    sel.addEventListener('change', sync);

    sync();
    var api = { el: wrap, combo: combo, refresh: function () { sync(); if (open) build(); }, close: close };
    sel.__a11ySel = api;
    return api;
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll('select[data-a11y-select]').forEach(enhance);
  }

  window.A11ySelect = { enhance: enhance, enhanceAll: enhanceAll };
  whenReady(function () { enhanceAll(); });
})();
