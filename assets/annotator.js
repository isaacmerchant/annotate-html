/*! annotator.js v0.1.0 (POC)
 * Drop-in feedback overlay for static HTML prototypes. No dependencies, no server.
 *
 * Usage (one tag, end of <body>):
 *   <script src="annotator.js" data-project="my-prototype" data-variant="v1"
 *     data-variants='[{"id":"v1","label":"v1","path":"../v1/"},{"id":"v2","label":"v2","path":"../v2/"}]'></script>
 * Optional: data-component-prefix="ds-" names design-system components in feedback (ds-card__body -> ds-card).
 *
 * Variants, two ways:
 *   1. Folder mode: data-variants as above. Switching opens the same page in the other folder.
 *   2. In-file mode: wrap alternatives in <section data-variant="A" data-variant-label="Dense">.
 *      Only the active one is shown.
 * Page id: <body data-page="..."> or the file name.
 * Stable anchors: add data-annot-id="..." to elements (esp. JS-rendered ones).
 */
(function () {
  'use strict';
  if (window.__uiAnnotator) return;
  window.__uiAnnotator = true;

  var VERSION = '0.1.0';
  var script = document.currentScript;
  var ds = (script && script.dataset) || {};

  function parseJSON(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  var cfg = {
    project: ds.project || 'prototype',
    variant: ds.variant || '',
    variants: parseJSON(ds.variants) || [],
    componentPrefix: ds.componentPrefix || '',
    send: ds.send === '1',   // set by annotate.py: the proxy accepts feedback at /__annotate/send
    boot: ds.boot || ''
  };

  /* ---------- storage ---------- */
  var KEY = 'uia:' + cfg.project;
  var ACTIVE_KEY = KEY + ':active-variant';
  var mem = {};
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return mem[k] || null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } }

  var store = loadStore();
  function loadStore() {
    var s = parseJSON(lsGet(KEY));
    if (!s || !Array.isArray(s.comments)) s = { v: 1, project: cfg.project, author: '', comments: [] };
    /* annotate.py stamps each launch with data-run. A new run means the app was relaunched after the
       last feedback was actioned, so start clean (keep the author name). Reloads keep their comments. */
    if (ds.run && lsGet(KEY + ':run') !== ds.run) {
      s.comments = [];
      lsSet(KEY + ':run', ds.run);
      lsSet(KEY, JSON.stringify(s));
    }
    return s;
  }
  function saveStore() { lsSet(KEY, JSON.stringify(store)); }

  /* ---------- page / variant identity ---------- */
  var file = (location.pathname.split('/').pop() || 'index.html').replace(/\.annotated(\.html?)$/i, '$1');
  function pageId() { return (document.body && document.body.dataset.page) || file; }
  function cleanSearch() {
    var u = new URLSearchParams(location.search); u.delete('uia-focus');
    var q = u.toString(); return q ? '?' + q : '';
  }
  function pageFile() { return file + cleanSearch(); }

  /* What the reviewer was looking at: full route (incl. #hash) and any visible filter/sort/search
     controls that hold a value, so a comment on a data-driven view can be reproduced. */
  function viewUrl() { return location.pathname + cleanSearch() + location.hash; }
  function labelText(el) {  // label text without the controls it wraps (a wrapped <select> would add all its options)
    var l = el.labels && el.labels[0];
    if (!l) return '';
    var c = l.cloneNode(true);
    [].forEach.call(c.querySelectorAll('select, input, textarea, option'), function (n) { n.remove(); });
    return c.textContent;
  }
  function viewState() {
    var out = [];
    [].forEach.call(document.querySelectorAll('select, input, textarea'), function (el) {
      if (out.length >= 20 || !el.getClientRects().length) return;
      var t = (el.type || '').toLowerCase(), val;
      if (/^(password|hidden|file|button|submit|reset|image)$/.test(t)) return;
      if (el.tagName === 'SELECT') {
        val = [].map.call(el.selectedOptions, function (o) { return o.textContent.trim(); }).join(', ');
        if (!el.value) return;  // empty value = nothing chosen
      } else if (t === 'checkbox' || t === 'radio') val = el.checked ? (el.value && el.value !== 'on' ? el.value : 'on') : '';
      else val = el.value;
      if (!val) return;
      var lab = labelText(el) || el.getAttribute('aria-label') ||
        el.placeholder || el.name || el.id || el.tagName.toLowerCase();
      out.push({ label: lab.trim().replace(/\s+/g, ' ').slice(0, 40), value: String(val).slice(0, 80) });
    });
    return out;
  }

  var inFileEls = [].filter.call(document.querySelectorAll('[data-variant]'), function (el) { return el.tagName !== 'SCRIPT'; });
  var inFile = inFileEls.length > 0;
  if (inFile) {
    var seen = {};
    cfg.variants = [];
    inFileEls.forEach(function (el) {
      var id = el.dataset.variant;
      if (!seen[id]) { seen[id] = 1; cfg.variants.push({ id: id, label: el.dataset.variantLabel || id }); }
    });
    var saved = lsGet(ACTIVE_KEY);
    cfg.variant = seen[saved] ? saved : cfg.variants[0].id;
  }
  if (!cfg.variant && cfg.variants.length) cfg.variant = cfg.variants[0].id;
  if (!cfg.variant) cfg.variant = 'default';

  function variantLabel(id) {
    var v = cfg.variants.filter(function (x) { return x.id === id; })[0];
    return v ? v.label || v.id : id;
  }

  function applyInFileVariant() {
    if (!inFile) return;
    inFileEls.forEach(function (el) { el.hidden = el.dataset.variant !== cfg.variant; });
  }

  /* ---------- small helpers ---------- */
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function snippet(el, n) {
    return norm(el.innerText || el.value || el.getAttribute('alt') || el.getAttribute('aria-label') || '').slice(0, n || 80);
  }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return iso; }
  }

  var STABLE_ATTRS = ['data-annot-id', 'data-testid', 'data-id', 'data-code', 'data-vehicle', 'data-key'];
  function isUnique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } }

  function cssPath(el) {
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      if (n === document.body) { parts.unshift('body'); break; }
      if (n.id && isUnique('#' + CSS.escape(n.id))) { parts.unshift('#' + CSS.escape(n.id)); break; }
      var stable = null;
      var href = n.tagName === 'A' && n.getAttribute('href');
      if (href && href.charAt(0) !== '#') {
        var hs = 'a[href="' + href.replace(/"/g, '\\"') + '"]';
        if (isUnique(hs)) stable = hs;
      }
      for (var i = 0; !stable && i < STABLE_ATTRS.length; i++) {
        var v = n.getAttribute(STABLE_ATTRS[i]);
        if (v) {
          var s = n.tagName.toLowerCase() + '[' + STABLE_ATTRS[i] + '="' + v.replace(/"/g, '\\"') + '"]';
          if (isUnique(s)) { stable = s; break; }
        }
      }
      if (stable) { parts.unshift(stable); break; }
      var sel = n.tagName.toLowerCase();
      var p = n.parentElement;
      if (p) {
        var same = [].filter.call(p.children, function (c) { return c.tagName === n.tagName; });
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(sel);
      n = p;
    }
    return parts.join(' > ');
  }

  /* Nearest heading that clearly "owns" the element. Ambiguous (several candidates) falls back to a
     higher-level heading, so the label is never confidently wrong. */
  var HEADINGS = 'h1,h2,h3,h4,h5,h6';
  function level(hd) { return hd ? +hd.tagName.charAt(1) : 0; }
  function contextOf(el) {
    var all = [].filter.call(document.querySelectorAll(HEADINGS), function (x) { return !host.contains(x); });
    var own = el.closest ? el.closest(HEADINGS) : null;
    var myLevel = level(own || (el.matches && el.matches(HEADINGS) ? el : null));
    for (var n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      var inside = all.filter(function (x) { return n.contains(x) && x !== own && !el.contains(x); });
      if (inside.length === 1) return norm(inside[0].textContent).slice(0, 60);
      if (inside.length > 1) break;
    }
    var before = all.filter(function (x) {
      return x !== own && !el.contains(x) && (x.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        (!myLevel || level(x) < myLevel);
    });
    var pick = myLevel ? before[before.length - 1] : all[0];
    return pick ? norm(pick.textContent).slice(0, 60) : '';
  }

  /* Design-system hint: first class with the configured prefix on the element or an ancestor,
     reduced to the base component (ds-card__body -> ds-card). Off unless data-component-prefix is set. */
  function componentOf(el) {
    if (!cfg.componentPrefix) return '';
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cl = (n.getAttribute('class') || '').split(/\s+/);
      for (var i = 0; i < cl.length; i++) {
        if (cl[i].indexOf(cfg.componentPrefix) === 0) return cl[i].split('__')[0].split('--')[0];
      }
    }
    return '';
  }

  function baseAnchor(el) {
    return {
      selector: cssPath(el), tag: el.tagName.toLowerCase(), text: snippet(el), context: contextOf(el),
      classes: norm(el.getAttribute('class') || '').slice(0, 120), component: componentOf(el)
    };
  }

  /* elements fully or mostly inside a viewport-coordinate box, for area comments */
  var COVER_SEL = 'h1,h2,h3,h4,h5,h6,a,button,th,label,input,select,textarea,img,[data-annot-id],[data-code]';
  function coveredBy(box, scopeEl) {
    var out = [];
    [].forEach.call(scopeEl.querySelectorAll(COVER_SEL), function (x) {
      if (host.contains(x) || !visible(x)) return;
      var r = x.getBoundingClientRect();
      var ix = Math.max(0, Math.min(r.right, box.x + box.w) - Math.max(r.left, box.x));
      var iy = Math.max(0, Math.min(r.bottom, box.y + box.h) - Math.max(r.top, box.y));
      if (r.width * r.height && (ix * iy) / (r.width * r.height) >= 0.6) out.push(x);
    });
    return out;
  }

  function describe(a) {
    var t = a.text ? ' "' + a.text.slice(0, 50) + (a.text.length > 50 ? '…' : '') + '"' : '';
    return '<' + a.tag + '>' + t;
  }

  function resolveEl(a) {
    var el = null;
    try { el = document.querySelector(a.selector); } catch (e) { /* bad selector */ }
    if (el && a.text && snippet(el) !== a.text && a.tag) {
      var alt = [].filter.call(document.querySelectorAll(a.tag), function (c) { return snippet(c) === a.text; })[0];
      if (alt) el = alt;
    }
    if (!el && a.tag && a.text) {
      el = [].filter.call(document.querySelectorAll(a.tag), function (c) { return snippet(c) === a.text; })[0] || null;
    }
    return el;
  }

  function docRect(r) { return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }
  /* Showing, not just laid out: decks and tabs often keep inactive views laid out but hidden
     (visibility:hidden or opacity:0). Page scroll is ignored so marks below the fold still count. */
  function visible(el) {
    if (!el || el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden') return false;
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).opacity === '0') return false;
    }
    return true;
  }

  /* text anchoring */
  function textNodes(root) {
    var out = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }
  function rangeFromOffsets(root, start, end) {
    var nodes = textNodes(root), pos = 0, r = document.createRange(), s = false;
    for (var i = 0; i < nodes.length; i++) {
      var len = nodes[i].data.length;
      if (!s && start <= pos + len) { r.setStart(nodes[i], start - pos); s = true; }
      if (s && end <= pos + len) { r.setEnd(nodes[i], end - pos); return r; }
      pos += len;
    }
    return null;
  }
  function findQuote(a) {
    var root = null;
    try { root = document.querySelector(a.selector); } catch (e) { /* ignore */ }
    if (!root) root = document.body;
    var full = root.textContent, idxs = [], i = -1;
    while ((i = full.indexOf(a.quote, i + 1)) !== -1) idxs.push(i);
    if (!idxs.length && root !== document.body) { root = document.body; full = root.textContent; i = -1; while ((i = full.indexOf(a.quote, i + 1)) !== -1) idxs.push(i); }
    if (!idxs.length) return null;
    var best = idxs[0], score = -1;
    idxs.forEach(function (ix) {
      var sc = 0;
      if (a.prefix && full.slice(Math.max(0, ix - a.prefix.length), ix) === a.prefix) sc += 2;
      if (a.suffix && full.slice(ix + a.quote.length, ix + a.quote.length + a.suffix.length) === a.suffix) sc += 2;
      if (ix === a.start) sc += 1;
      if (sc > score) { score = sc; best = ix; }
    });
    return rangeFromOffsets(root, best, best + a.quote.length);
  }

  /* where is a comment now? returns {point:{x,y}, rects:[{x,y,w,h}], box?} in document coordinates, or null */
  function locate(c) {
    var a = c.anchor;
    if (!a) return null;
    if (c.type === 'pin') {
      var el = resolveEl(a);
      if (!visible(el)) return null;
      var r = docRect(el.getBoundingClientRect());
      return { point: { x: r.x + a.ox * r.w, y: r.y + a.oy * r.h }, rects: [r] };
    }
    if (c.type === 'area') {
      var e2 = resolveEl(a);
      if (!visible(e2)) return null;
      var r2 = docRect(e2.getBoundingClientRect());
      var box = { x: r2.x + a.dx, y: r2.y + a.dy, w: a.w, h: a.h };
      return { point: { x: box.x, y: box.y }, rects: [box], box: box };
    }
    if (c.type === 'text') {
      var rg = findQuote(a);
      if (!rg || !visible(rg.startContainer.parentElement)) return null;
      var rects = [].map.call(rg.getClientRects(), docRect).filter(function (q) { return q.w > 0 && q.h > 0; });
      if (!rects.length) return null;
      return { point: { x: rects[0].x, y: rects[0].y }, rects: rects };
    }
    return null;
  }

  /* ---------- host + styles ---------- */
  var host = h('div', { id: 'ui-annotator-host' });
  /* A viewport-sized, click-through box. (A 0x0 host clips its absolute children once it is a popover.)
     Marks live in .layer in document coordinates; follow() shifts the layer as the page scrolls. */
  host.style.cssText = 'all:initial;display:block;position:fixed;top:0;left:0;width:100vw;height:100vh;margin:0;padding:0;border:0;' +
    'background:transparent;overflow:hidden;pointer-events:none;z-index:2147483647;';
  var root = host.attachShadow({ mode: 'open' });
  /* Modal <dialog>s and page popovers live in the browser's top layer, above any z-index, and a modal
     makes everything outside it inert. So the host is a manual popover (top layer too), and while a
     modal is open it moves inside that modal and re-raises itself, staying on top and clickable. */
  var canTop = typeof host.showPopover === 'function';
  if (canTop) host.setAttribute('popover', 'manual');
  function raise() {
    if (!canTop || !host.isConnected) return;
    try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch (e) { /* not supported */ }
  }
  function syncTop() {
    var modals = [].filter.call(document.querySelectorAll('dialog[open]'), function (d) {
      try { return d.matches(':modal'); } catch (e) { return false; }
    });
    var parent = modals[modals.length - 1] || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    raise();
    schedule();
  }

  var CSS_TEXT = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.35}',
    '.layer{position:absolute;top:0;left:0;width:0;height:0;pointer-events:none}',
    '.ui{position:fixed;inset:0;pointer-events:none}',
    '.ui>*{pointer-events:auto}',
    /* toolbar */
    '.bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:4px;background:#1b1f2a;color:#fff;padding:6px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);width:max-content;max-width:calc(100vw - 16px);flex-wrap:nowrap;white-space:nowrap;overflow-x:auto;scrollbar-width:none}',
    '.bar>*{flex:none}',
    '.bar button,.bar select{background:transparent;color:#fff;border:1px solid transparent;border-radius:8px;padding:6px 10px;cursor:pointer;font-weight:500}',
    '.bar select{background:#2b3140;border-color:#3a4155;padding:6px 8px}',
    '.bar button:hover{background:#2b3140}',
    '.bar button.on{background:#c2255c;color:#fff}',
    '.bar button.send{background:#c2255c;font-weight:600;display:inline-flex;align-items:center;gap:5px}',
    '.bar button.send svg{display:block}',
    '.bar button.send:hover{background:#a51e4e}',
    '.modal .row{display:flex;gap:8px;justify-content:flex-end}',
    '.bar .sep{width:1px;align-self:stretch;background:#3a4155;margin:2px 4px}',
    '.bar .count{background:#c2255c;border-radius:10px;padding:0 6px;margin-left:4px;font-size:11px}',
    '.bar .who{color:#aab1c5;font-size:12px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    /* menus */
    '.menu{position:fixed;bottom:70px;right:calc(50% - 160px);background:#fff;color:#1b1f2a;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);padding:4px;min-width:200px}',
    '.menu button{display:block;width:100%;text-align:left;background:none;border:0;padding:8px 10px;border-radius:6px;cursor:pointer}',
    '.menu button:hover{background:#f0f2f7}',
    '.menu button.danger{color:#b42318}',
    /* panel */
    '.panel{position:fixed;top:12px;right:12px;bottom:76px;width:340px;max-width:calc(100vw - 24px);background:#fff;color:#1b1f2a;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden}',
    '.panel header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e3e6ee}',
    '.panel header b{font-size:14px;flex:1}',
    '.panel header button{background:none;border:0;cursor:pointer;font-size:16px;color:#667}',
    '.tabs{display:flex;gap:4px;padding:8px 12px 0}',
    '.tabs button{background:#eef0f6;border:0;border-radius:14px;padding:3px 10px;cursor:pointer}',
    '.tabs button.on{background:#1b1f2a;color:#fff}',
    '.list{overflow:auto;padding:8px 12px;flex:1}',
    '.empty{color:#778;padding:16px 0;text-align:center}',
    '.item{border:1px solid #e3e6ee;border-radius:10px;padding:8px 10px;margin-bottom:8px;cursor:pointer}',
    '.item:hover{border-color:#c2255c}',
    '.item .top{display:flex;align-items:center;gap:6px;color:#667;font-size:12px}',
    '.item .num{background:#c2255c;color:#fff;border-radius:50%;min-width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;padding:0 4px}',
    '.item .num.g{background:#1b1f2a;border-radius:10px}',
    '.item .chip{background:#eef0f6;border-radius:8px;padding:0 6px;text-transform:uppercase;font-size:10px;letter-spacing:.04em}',
    '.item .txt{margin:6px 0;white-space:pre-wrap;word-break:break-word}',
    '.item .tgt{color:#667;font-size:12px;font-family:ui-monospace,Consolas,monospace;word-break:break-all}',
    '.item .where{color:#667;font-size:12px;margin-top:2px}',
    '.item .warn{color:#b54708;font-size:12px}',
    '.item .acts{margin-top:6px;display:flex;gap:10px}',
    '.item .acts button{background:none;border:0;color:#2557d6;cursor:pointer;padding:0}',
    '.item .acts button.danger{color:#b42318}',
    /* popover + modal */
    '.pop{position:fixed;width:320px;background:#fff;color:#1b1f2a;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.35);padding:12px}',
    '.pop .hd{font-weight:600;margin-bottom:2px}',
    '.pop .sub{color:#667;font-size:12px;margin-bottom:8px;word-break:break-word}',
    '.pop textarea{width:100%;min-height:84px;resize:vertical;border:1px solid #c9cedb;border-radius:8px;padding:8px}',
    '.pop select{margin:6px 6px 0 0;border:1px solid #c9cedb;border-radius:8px;padding:4px;max-width:100%}',
    '.item .chip.k{background:#1b1f2a;color:#fff}',
    '.pop .row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}',
    '.btn{border:1px solid #c9cedb;background:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}',
    '.btn.primary{background:#c2255c;border-color:#c2255c;color:#fff}',
    '.btn.danger{color:#b42318}',
    '.modalbg{position:fixed;inset:0;background:rgba(15,18,28,.55);display:flex;align-items:center;justify-content:center}',
    '.modal{background:#fff;color:#1b1f2a;border-radius:14px;padding:20px;width:360px;max-width:calc(100vw - 24px)}',
    '.modal h2{margin:0 0 6px;font-size:16px}',
    '.modal p{margin:0 0 12px;color:#556}',
    '.modal input{width:100%;border:1px solid #c9cedb;border-radius:8px;padding:8px;margin-bottom:12px}',
    '.toast{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);background:#1b1f2a;color:#fff;padding:8px 14px;border-radius:8px}',
    '.hint{position:fixed;left:50%;top:12px;transform:translateX(-50%);background:#1b1f2a;color:#fff;padding:6px 14px;border-radius:20px;font-size:12px}',
    /* marks on page */
    '.grp{position:absolute;top:0;left:0;width:0;height:0}',
    '.marker{position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;background:#c2255c;color:#fff;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;cursor:pointer;pointer-events:auto}',
    '.marker.pulse{animation:pulse .9s ease-out 2}',
    '@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(194,37,92,.7)}100%{box-shadow:0 0 0 18px rgba(194,37,92,0)}}',
    '.hl{position:absolute;background:rgba(255,213,0,.35);border-bottom:2px solid #c2255c;pointer-events:none}',
    '.areabox{position:absolute;border:2px dashed #c2255c;background:rgba(194,37,92,.08);pointer-events:none}',
    '.pinbox{position:absolute;border:2px dashed #c2255c;background:rgba(194,37,92,.06);display:none;pointer-events:none}',
    '.grp:hover .pinbox{display:block}',
    '.hover{position:absolute;border:2px solid #2557d6;background:rgba(37,87,214,.12);pointer-events:none}',
    '.rubber{position:absolute;border:2px dashed #2557d6;background:rgba(37,87,214,.1);pointer-events:none}'
  ].join('\n');

  root.appendChild(h('style', { text: CSS_TEXT }));
  var layer = h('div', { class: 'layer' });
  var ui = h('div', { class: 'ui' });
  root.appendChild(layer);
  root.appendChild(ui);
  function follow() { layer.style.transform = 'translate(' + -scrollX + 'px,' + -scrollY + 'px)'; }

  var pageStyle = h('style', {
    text: '[data-variant][hidden]{display:none!important}' +
      'html.uia-mode, html.uia-mode *{cursor:crosshair!important}' +
      'html.uia-text, html.uia-text *{cursor:text!important}'
  });

  /* ---------- state ---------- */
  var state = { mode: 'browse', markers: true, panel: false, scope: 'page', pop: null, menu: false };
  var hoverBox = null, hoverEl = null, rubber = null;

  var MODES = [
    ['browse', 'Browse', 'Use the page normally'],
    ['pin', 'Pin', 'Click an element to comment on it'],
    ['text', 'Text', 'Select text, then comment'],
    ['area', 'Area', 'Drag a box around an area']
  ];
  var HINTS = {
    pin: 'Pin: click any element. Esc to stop.',
    text: 'Text: select some text on the page. Esc to stop.',
    area: 'Area: drag a box. Esc to stop.'
  };

  /* ---------- numbering / queries ---------- */
  function mine(c) { return c.variant === cfg.variant && c.page === pageId(); }
  function visibleComments() {
    var out = store.comments.filter(function (c) { return c.scope === 'project' || mine(c); });
    return out;
  }
  function numbering() {
    var map = {}, groups = {};
    store.comments.slice().sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; }).forEach(function (c) {
      if (c.type === 'global') return;
      var k = c.variant + '|' + c.page;
      groups[k] = (groups[k] || 0) + 1;
      map[c.id] = groups[k];
    });
    return map;
  }

  /* ---------- rendering the marks ---------- */
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; render(); });
  }

  function place(el, r) {
    el.style.left = r.x + 'px'; el.style.top = r.y + 'px';
    el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
    return el;
  }

  function renderMarks() {
    layer.textContent = '';
    // keep the live pin highlight and area rubber band: pages that animate (typing effects, carousels)
    // re-render constantly, and wiping these made them vanish
    if (hoverBox) {
      if (hoverEl && hoverEl.isConnected) place(hoverBox, docRect(hoverEl.getBoundingClientRect()));
      layer.appendChild(hoverBox);
    }
    if (rubber) layer.appendChild(rubber);
    if (!state.markers) return;
    var nums = numbering();
    store.comments.filter(mine).forEach(function (c) {
      if (c.type === 'global') return;
      var loc = locate(c);
      if (!loc) return;
      var g = h('div', { class: 'grp', 'data-id': c.id });
      if (c.type === 'text') loc.rects.forEach(function (r) { g.appendChild(place(h('div', { class: 'hl' }), r)); });
      if (c.type === 'area') g.appendChild(place(h('div', { class: 'areabox' }), loc.box));
      if (c.type === 'pin') g.appendChild(place(h('div', { class: 'pinbox' }), loc.rects[0]));
      var m = h('div', { class: 'marker', title: c.text, onclick: function (e) { e.stopPropagation(); openPopover({ existing: c }); } }, String(nums[c.id]));
      m.style.left = loc.point.x + 'px'; m.style.top = loc.point.y + 'px';
      g.appendChild(m);
      layer.appendChild(g);
    });
  }

  /* ---------- UI: toolbar ---------- */
  var barEl, panelEl, popEl, menuEl, toastEl, hintEl, modalEl;
  var ROBOT = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M8 1.5v2.5"/><circle cx="8" cy="1.5" r=".6" fill="currentColor"/><rect x="2.5" y="4" width="11" height="9" rx="2.5"/>' +
    '<circle cx="5.8" cy="8.2" r="1" fill="currentColor" stroke="none"/><circle cx="10.2" cy="8.2" r="1" fill="currentColor" stroke="none"/>' +
    '<path d="M6 11h4"/><path d="M1 8v2M15 8v2"/></svg>';

  function renderBar() {
    if (barEl) barEl.remove();
    var count = visibleComments().length;
    var kids = [];
    MODES.forEach(function (m) {
      kids.push(h('button', { class: state.mode === m[0] ? 'on' : '', title: m[2], onclick: function () { setMode(m[0]); } }, m[1]));
    });
    kids.push(h('button', { title: 'Comment on this whole page', onclick: function () { openPopover({ type: 'global' }); } }, 'Page note'));
    kids.push(h('div', { class: 'sep' }));
    if (cfg.variants.length > 1) {
      var sel = h('select', { title: 'Switch variant', onchange: function (e) { switchVariant(e.target.value); } });
      cfg.variants.forEach(function (v) {
        var o = h('option', { value: v.id }, v.label || v.id);
        if (v.id === cfg.variant) o.selected = true;
        sel.appendChild(o);
      });
      kids.push(sel);
      kids.push(h('div', { class: 'sep' }));
    }
    kids.push(h('button', { class: state.panel ? 'on' : '', title: 'Show comments', onclick: function () { state.panel = !state.panel; renderAll(); } },
      'Comments', h('span', { class: 'count' }, String(count))));
    kids.push(h('button', { title: state.markers ? 'Hide markers' : 'Show markers', onclick: function () { state.markers = !state.markers; renderAll(); } }, state.markers ? 'Hide' : 'Show'));
    kids.push(h('button', { onclick: function () { state.menu = !state.menu; renderMenu(); } }, 'Export ▾'));
    if (cfg.send) {
      var send = h('button', { class: 'send', title: 'Send to agent: hand all comments to your coding agent, then wait for the updated page', 'aria-label': 'Send to agent', onclick: sendToAgent }, '→');
      send.insertAdjacentHTML('beforeend', ROBOT);
      kids.push(send);
    }
    kids.push(h('div', { class: 'sep' }));
    kids.push(h('button', { class: 'who', title: 'Change name', onclick: askName }, store.author || 'Set name'));
    barEl = h.apply(null, ['div', { class: 'bar' }].concat(kids));
    ui.appendChild(barEl);
  }

  function renderMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
    if (!state.menu) return;
    var items = [
      ['Copy as text', function () { copy(buildText(), 'Copied text summary'); }],
      ['Copy as JSON', function () { copy(JSON.stringify(buildExport(), null, 2), 'Copied JSON'); }],
      ['Save as text file…', function () { saveAs(buildText(), 'txt', 'text/plain'); }],
      ['Save as JSON file…', function () { saveAs(JSON.stringify(buildExport(), null, 2), 'json', 'application/json'); }],
      ['Clear all comments…', function () {
        if (confirm('Delete all ' + store.comments.length + ' comments in this prototype? This cannot be undone.')) { store.comments = []; saveStore(); renderAll(); }
      }, 'danger']
    ];
    menuEl = h.apply(null, ['div', { class: 'menu' }].concat(items.map(function (it) {
      return h('button', { class: it[2] || '', onclick: function () { state.menu = false; renderMenu(); it[1](); } }, it[0]);
    })));
    ui.appendChild(menuEl);
  }

  function toast(msg) {
    if (toastEl) toastEl.remove();
    toastEl = h('div', { class: 'toast' }, msg);
    ui.appendChild(toastEl);
    setTimeout(function () { if (toastEl) { toastEl.remove(); toastEl = null; } }, 2200);
  }

  function renderHint() {
    if (hintEl) hintEl.remove();
    hintEl = null;
    if (HINTS[state.mode]) { hintEl = h('div', { class: 'hint' }, HINTS[state.mode]); ui.appendChild(hintEl); }
  }

  /* ---------- UI: panel ---------- */
  function renderPanel() {
    if (panelEl) panelEl.remove();
    panelEl = null;
    if (!state.panel) return;
    var nums = numbering();
    var list = store.comments.filter(function (c) {
      return state.scope === 'all' || c.scope === 'project' || mine(c);
    }).sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
    var body = h('div', { class: 'list' });
    if (!list.length) body.appendChild(h('div', { class: 'empty' }, state.scope === 'page' ? 'No comments on this page yet.' : 'No comments yet.'));
    list.forEach(function (c) {
      var here = mine(c) || c.scope === 'project';
      var loc = here && c.type !== 'global' ? locate(c) : null;
      var top = h('div', { class: 'top' },
        h('span', { class: 'num' + (c.type === 'global' ? ' g' : '') }, c.type === 'global' ? (c.scope === 'project' ? 'All' : 'Note') : String(nums[c.id])),
        h('span', { class: 'chip' }, c.type === 'global' ? 'page note' : c.type),
        c.kind ? h('span', { class: 'chip k' }, c.kind) : null,
        h('span', null, c.author + ' · ' + fmtDate(c.createdAt)));
      var item = h('div', { class: 'item', onclick: function () { goTo(c); } },
        top, h('div', { class: 'txt' }, c.text));
      if (c.anchor) item.appendChild(h('div', { class: 'tgt' }, c.type === 'text' ? '“' + c.anchor.quote.slice(0, 80) + (c.anchor.quote.length > 80 ? '…' : '') + '”' : describe(c.anchor)));
      if (state.scope === 'all' && c.scope !== 'project') item.appendChild(h('div', { class: 'where' }, variantLabel(c.variant) + ' · ' + c.pageTitle));
      if (here && c.anchor && !loc) item.appendChild(h('div', { class: 'warn' }, '⚠ Element not found on the page right now'));
      item.appendChild(h('div', { class: 'acts' },
        h('button', { onclick: function (e) { e.stopPropagation(); openPopover({ existing: c }); } }, 'Edit'),
        h('button', { class: 'danger', onclick: function (e) { e.stopPropagation(); removeComment(c.id); } }, 'Delete')));
      body.appendChild(item);
    });
    function tab(id, label) {
      return h('button', { class: state.scope === id ? 'on' : '', onclick: function () { state.scope = id; renderPanel(); } }, label);
    }
    panelEl = h('div', { class: 'panel' },
      h('header', null, h('b', null, 'Comments'), h('button', { title: 'Close', onclick: function () { state.panel = false; renderAll(); } }, '✕')),
      h('div', { class: 'tabs' }, tab('page', 'This page'), tab('all', 'Whole prototype')),
      body);
    ui.appendChild(panelEl);
  }

  /* ---------- go to a comment ---------- */
  function urlFor(c) {
    if (c.variant !== cfg.variant && !inFile) {
      var v = cfg.variants.filter(function (x) { return x.id === c.variant; })[0];
      if (v && v.path) return new URL(v.path + c.file, location.href).href;
    }
    return new URL(c.file, location.href).href;
  }
  function goTo(c) {
    var sameView = (c.scope === 'project' || mine(c));
    if (!sameView) {
      if (inFile && c.page === pageId()) { switchVariant(c.variant, c.id); return; }
      var u = new URL(urlFor(c));
      u.searchParams.set('uia-focus', c.id);
      location.href = u.href;
      return;
    }
    focusComment(c.id);
  }
  function focusComment(id) {
    var c = store.comments.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    var loc = locate(c);
    if (!loc) { if (c.type === 'global') openPopover({ existing: c }); return; }
    var y = Math.max(0, loc.point.y - innerHeight / 3);
    window.scrollTo({ top: y, behavior: 'smooth' });
    setTimeout(function () {
      var m = layer.querySelector('.grp[data-id="' + id + '"] .marker');
      if (m) { m.classList.remove('pulse'); void m.offsetWidth; m.classList.add('pulse'); }
    }, 350);
  }

  function switchVariant(id, focusId) {
    if (id === cfg.variant) return;
    if (inFile) {
      cfg.variant = id; lsSet(ACTIVE_KEY, id);
      applyInFileVariant();
      renderAll();
      if (focusId) setTimeout(function () { focusComment(focusId); }, 100);
      return;
    }
    var v = cfg.variants.filter(function (x) { return x.id === id; })[0];
    if (!v || !v.path) { toast('No path configured for variant ' + id); renderBar(); return; }
    var u = new URL(v.path + file + cleanSearch() + location.hash, location.href);
    location.href = u.href;
  }

  /* ---------- UI: name modal ---------- */
  function askName() {
    if (modalEl) return;
    var input = h('input', { type: 'text', placeholder: 'Your name', value: store.author || '' });
    function done() {
      var v = norm(input.value);
      if (!v) { input.focus(); return; }
      store.author = v; saveStore();
      modalEl.remove(); modalEl = null;
      renderAll();
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') done(); });
    modalEl = h('div', { class: 'modalbg' },
      h('div', { class: 'modal' },
        h('h2', null, 'Before you start'),
        h('p', null, 'Add your name so we know who left each comment. Comments are saved in this browser until you send or export them.'),
        input,
        h('button', { class: 'btn primary', onclick: done }, 'Start reviewing')));
    ui.appendChild(modalEl);
    setTimeout(function () { input.focus(); }, 0);
  }

  /* ---------- UI: comment popover ---------- */
  function closePopover() {
    if (popEl) popEl.remove();
    popEl = null; state.pop = null;
    var s = getSelection(); if (s) s.removeAllRanges();
  }

  // opts: {type, anchor, at:{x,y} viewport} for new; {existing} for edit
  function openPopover(opts) {
    if (!store.author) { askName(); return; }
    closePopover();
    var c = opts.existing;
    var type = c ? c.type : opts.type;
    var anchor = c ? c.anchor : opts.anchor;
    var scope = c ? c.scope : 'page';
    state.pop = opts;

    var title = { pin: 'Comment on element', text: 'Comment on text', area: 'Comment on area', global: 'Page note' }[type];
    var sub = type === 'global' ? variantLabel(cfg.variant) + ' · ' + (document.title || pageId())
      : type === 'text' ? '“' + anchor.quote.slice(0, 120) + (anchor.quote.length > 120 ? '…' : '') + '”'
        : describe(anchor);
    var ta = h('textarea', { placeholder: type === 'text' ? 'What should it say instead?' : 'What did you notice, and what would you prefer?' });
    ta.value = c ? c.text : '';
    var kindSel = h('select', { title: 'Type of feedback' },
      h('option', { value: '' }, 'Type (optional)'),
      h('option', { value: 'problem' }, 'Problem: something is wrong'),
      h('option', { value: 'suggestion' }, 'Suggestion: I would change this'),
      h('option', { value: 'question' }, 'Question: I do not understand'),
      h('option', { value: 'like' }, 'Like: keep this'));
    kindSel.value = (c && c.kind) || '';
    var scopeSel = null;
    if (type === 'global') {
      scopeSel = h('select', null,
        h('option', { value: 'page' }, 'Applies to: this page'),
        h('option', { value: 'project' }, 'Applies to: whole prototype'));
      scopeSel.value = scope;
    }
    function save() {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (c) {
        c.text = text; c.editedAt = new Date().toISOString(); c.kind = kindSel.value;
        if (scopeSel) c.scope = scopeSel.value;
      } else {
        store.comments.push({
          id: uid(), type: type, kind: kindSel.value, text: text, author: store.author, createdAt: new Date().toISOString(),
          scope: scopeSel ? scopeSel.value : 'page',
          project: cfg.project, variant: cfg.variant, page: pageId(), file: pageFile(), pageTitle: document.title,
          url: viewUrl(), state: viewState(),
          viewport: { w: innerWidth, h: innerHeight }, anchor: anchor || null
        });
      }
      saveStore(); closePopover(); renderAll();
    }
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save();
    });
    var row = h('div', { class: 'row' });
    if (c) row.appendChild(h('button', { class: 'btn danger', onclick: function () { closePopover(); removeComment(c.id); } }, 'Delete'));
    row.appendChild(h('button', { class: 'btn', onclick: closePopover }, 'Cancel'));
    row.appendChild(h('button', { class: 'btn primary', onclick: save }, c ? 'Update' : 'Save'));
    popEl = h('div', { class: 'pop' }, h('div', { class: 'hd' }, title), h('div', { class: 'sub' }, sub), ta, kindSel, scopeSel, row);

    var at = opts.at;
    if (!at && c) {
      var loc = locate(c);
      at = loc ? { x: loc.point.x - scrollX, y: loc.point.y - scrollY } : null;
    }
    if (!at) at = { x: innerWidth / 2 - 160, y: innerHeight / 3 };
    popEl.style.left = Math.max(8, Math.min(at.x + 16, innerWidth - 336)) + 'px';
    popEl.style.top = Math.max(8, Math.min(at.y + 16, innerHeight - 260)) + 'px';
    ui.appendChild(popEl);
    setTimeout(function () { ta.focus(); }, 0);
  }

  function removeComment(id) {
    store.comments = store.comments.filter(function (c) { return c.id !== id; });
    saveStore(); renderAll();
  }

  /* ---------- modes ---------- */
  function setMode(m) {
    closePopover();
    state.mode = m;
    clearHover(); clearRubber();
    document.documentElement.classList.toggle('uia-mode', m === 'pin' || m === 'area');
    document.documentElement.classList.toggle('uia-text', m === 'text');
    renderBar(); renderHint();
  }
  function clearHover() { if (hoverBox) { hoverBox.remove(); hoverBox = null; } hoverEl = null; }
  function clearRubber() { if (rubber) { rubber.remove(); rubber = null; } }

  function isOwn(e) { var p = e.composedPath ? e.composedPath() : []; return p.indexOf(host) !== -1; }
  function pick(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    return el && el !== host && !host.contains(el) ? el : null;
  }

  function elementAnchor(el, e) {
    var r = el.getBoundingClientRect();
    var a = baseAnchor(el);
    a.ox = r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
    a.oy = r.height ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0;
    return a;
  }

  var dragStart = null;

  function onMove(e) {
    if (state.mode === 'pin' && !isOwn(e)) {
      var el = pick(e);
      if (!el) { clearHover(); return; }
      if (!hoverBox) { hoverBox = h('div', { class: 'hover' }); layer.appendChild(hoverBox); }
      hoverEl = el;
      place(hoverBox, docRect(el.getBoundingClientRect()));
    } else if (state.mode === 'area' && dragStart) {
      var x = Math.min(dragStart.x, e.pageX), y = Math.min(dragStart.y, e.pageY);
      if (!rubber) { rubber = h('div', { class: 'rubber' }); layer.appendChild(rubber); }
      place(rubber, { x: x, y: y, w: Math.abs(e.pageX - dragStart.x), h: Math.abs(e.pageY - dragStart.y) });
    }
  }

  function onDown(e) {
    if (state.mode === 'browse' || isOwn(e)) return;
    if (state.mode === 'area') { e.preventDefault(); e.stopPropagation(); dragStart = { x: e.pageX, y: e.pageY }; return; }
    if (state.mode === 'pin') { e.preventDefault(); e.stopPropagation(); }
  }

  function onUp(e) {
    if (state.mode === 'browse' || isOwn(e)) return;
    if (state.mode === 'pin') {
      e.preventDefault(); e.stopPropagation();
      var el = pick(e);
      if (!el) return;
      clearHover();
      openPopover({ type: 'pin', anchor: elementAnchor(el, e), at: { x: e.clientX, y: e.clientY } });
    } else if (state.mode === 'area' && dragStart) {
      e.preventDefault(); e.stopPropagation();
      var w = Math.abs(e.pageX - dragStart.x), hh = Math.abs(e.pageY - dragStart.y);
      var x = Math.min(dragStart.x, e.pageX), y = Math.min(dragStart.y, e.pageY);
      dragStart = null; clearRubber();
      if (w < 8 || hh < 8) return;
      // anchor to the smallest element that contains the whole box, not whatever sits at its centre
      var vb = { x: x - scrollX, y: y - scrollY, w: w, h: hh };
      var el2 = document.elementFromPoint(vb.x + w / 2, vb.y + hh / 2);
      if (!el2 || host.contains(el2)) el2 = document.body;
      while (el2 !== document.body && el2.parentElement) {
        var cr = el2.getBoundingClientRect();
        if (cr.left <= vb.x + 1 && cr.top <= vb.y + 1 && cr.right >= vb.x + w - 1 && cr.bottom >= vb.y + hh - 1) break;
        el2 = el2.parentElement;
      }
      var r = docRect(el2.getBoundingClientRect());
      var a = baseAnchor(el2);
      a.dx = x - r.x; a.dy = y - r.y; a.w = w; a.h = hh;
      var cov = coveredBy(vb, el2);
      a.coversCount = cov.length;
      a.covers = cov.slice(0, 8).map(function (x2) { return { tag: x2.tagName.toLowerCase(), text: snippet(x2, 40), selector: cssPath(x2) }; });
      openPopover({ type: 'area', anchor: a, at: { x: x + w - scrollX, y: y + hh - scrollY } });
    } else if (state.mode === 'text') {
      setTimeout(function () { captureSelection(e); }, 0);
    }
  }

  function captureSelection(e) {
    var sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (host.contains(range.commonAncestorContainer) || (range.commonAncestorContainer.getRootNode && range.commonAncestorContainer.getRootNode() === root)) return;
    var raw = range.toString();
    var quote = norm(raw);
    if (quote.length < 2) return;
    var lead = raw.length - raw.replace(/^\s+/, '').length;
    var container = range.commonAncestorContainer;
    if (container.nodeType !== 1) container = container.parentElement;
    var pre = document.createRange();
    pre.selectNodeContents(container);
    pre.setEnd(range.startContainer, range.startOffset);
    var start = pre.toString().length + lead;
    var full = container.textContent;
    var q = raw.trim();
    var anchor = baseAnchor(container);
    anchor.quote = q.slice(0, 300); anchor.start = start;
    anchor.prefix = full.slice(Math.max(0, start - 30), start);
    anchor.suffix = full.slice(start + q.length, start + q.length + 30);
    var rects = range.getClientRects();
    var last = rects[rects.length - 1] || { right: e.clientX, bottom: e.clientY };
    openPopover({ type: 'text', anchor: anchor, at: { x: last.right, y: last.bottom } });
  }

  function onClick(e) {
    if (state.mode === 'browse' || isOwn(e)) return;
    e.preventDefault(); e.stopPropagation();
  }

  function onKey(e) {
    // Esc that closes our own UI must not also close the page's dialog underneath
    if (e.key === 'Escape' && handleEsc()) { e.preventDefault(); e.stopPropagation(); }
  }
  function handleEsc() {
    if (modalEl) return true;
    if (popEl) { closePopover(); return true; }
    if (state.menu) { state.menu = false; renderMenu(); return true; }
    if (state.mode !== 'browse') { setMode('browse'); return true; }
    return false;
  }

  /* ---------- export ---------- */
  function buildExport() {
    return {
      tool: 'annotator.js', toolVersion: VERSION, project: cfg.project, reviewer: store.author,
      exportedAt: new Date().toISOString(), commentCount: store.comments.length,
      comments: store.comments.slice().sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; })
    };
  }

  function buildText() {
    var nums = numbering();
    var all = store.comments.slice().sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
    var lines = [
      'FEEDBACK: ' + cfg.project,
      'Reviewer: ' + (store.author || '(unnamed)') + '   Exported: ' + new Date().toLocaleString('en-GB') + '   Comments: ' + all.length,
      ''
    ];
    var groups = {}, order = [];
    all.forEach(function (c) {
      var k = c.scope === 'project' ? '*|*' : c.variant + '|' + c.page;
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(c);
    });
    order.sort(function (a, b) { return a === '*|*' ? -1 : b === '*|*' ? 1 : a < b ? -1 : 1; });
    order.forEach(function (k) {
      var first = groups[k][0];
      lines.push(k === '*|*' ? '## Whole prototype' : '## Variant ' + variantLabel(first.variant) + ' / Page: ' + first.pageTitle + ' (' + first.file + ')');
      groups[k].forEach(function (c) {
        var tag = (c.type === 'global' ? 'NOTE' : '#' + nums[c.id] + ' ' + c.type.toUpperCase()) + (c.kind ? ' / ' + c.kind.toUpperCase() : '');
        lines.push('[' + tag + '] ' + c.text.replace(/\n/g, '\n    '));
        var a = c.anchor;
        if (a) {
          if (c.type === 'text') lines.push('    Text: "' + a.quote + '"');
          lines.push('    ' + (c.type === 'area' ? 'Inside: ' : 'Element: ') + describe(a) + (a.context ? ' (under "' + a.context + '")' : ''));
          if (a.component) lines.push('    Component: ' + a.component);
          if (a.classes) lines.push('    Classes: ' + a.classes);
          lines.push('    Selector: ' + a.selector);
          if (c.type === 'area') {
            lines.push('    Area: ' + Math.round(a.w) + 'x' + Math.round(a.h) + 'px at viewport ' + (c.viewport ? c.viewport.w + 'x' + c.viewport.h : '?'));
            if (a.covers && a.covers.length) {
              lines.push('    Covers: ' + a.covers.map(function (x) { return describe(x); }).join(', ') +
                (a.coversCount > a.covers.length ? ' (+' + (a.coversCount - a.covers.length) + ' more)' : ''));
            }
          }
        }
        if (c.url && /[?#]/.test(c.url)) lines.push('    View: ' + c.url);
        if (c.state && c.state.length) lines.push('    Filters: ' + c.state.map(function (s) { return s.label + ' = ' + s.value; }).join('; '));
        lines.push('    ' + c.author + ', ' + fmtDate(c.createdAt) + (c.viewport && c.type !== 'area' ? ', viewport ' + c.viewport.w + 'x' + c.viewport.h : ''));
      });
      lines.push('');
    });
    return lines.join('\n');
  }

  function copy(text, msg) {
    function fallback() {
      var t = document.createElement('textarea');
      t.value = text; t.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(t); t.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
      t.remove();
      toast(ok ? msg : 'Copy failed. Use Download instead.');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(msg); }, fallback);
    } else fallback();
  }

  function fileName(ext) {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return 'feedback-' + cfg.project + '-' + (store.author || 'reviewer').toLowerCase().replace(/[^a-z0-9]+/g, '-') +
      '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.' + ext;
  }

  /* Save As dialog where the browser supports it (Chrome, Edge); plain download otherwise. */
  function saveAs(text, ext, mime) {
    if (!window.showSaveFilePicker) { download(text, ext, mime); return; }
    var accept = {}; accept[mime] = ['.' + ext];
    var name = fileName(ext);
    window.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.toUpperCase() + ' file', accept: accept }] })
      .then(function (handle) {
        return handle.createWritable().then(function (w) { return w.write(text).then(function () { return w.close(); }); })
          .then(function () { toast('Saved ' + handle.name); });
      })
      .catch(function (err) { if (!err || err.name !== 'AbortError') download(text, ext, mime); });
  }

  function download(text, ext, mime) {
    var name = fileName(ext);
    var a = h('a', { href: URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' })), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    toast('Downloaded ' + name);
  }

  /* ---------- send to agent (only when served by annotate.py) ---------- */
  var sending = false;
  function sendToAgent() {
    if (sending) return;
    if (!store.comments.length) { toast('Add a comment first'); return; }
    if (modalEl) return;
    var n = store.comments.length;
    modalEl = h('div', { class: 'modalbg' },
      h('div', { class: 'modal' },
        h('h2', null, 'Send ' + n + ' comment' + (n === 1 ? '' : 's') + ' to your agent?'),
        h('p', null, 'This ends the round. The page waits here and reloads when the updated version is ready.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: function () { modalEl.remove(); modalEl = null; } }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: doSend }, 'Send'))));
    ui.appendChild(modalEl);
  }
  function doSend() {
    sending = true;
    fetch('/__annotate/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: buildText(), json: buildExport() })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      showWaiting();
    }).catch(function () {
      sending = false;
      if (modalEl) { modalEl.remove(); modalEl = null; }
      toast('Send failed. Use Export instead.');
    });
  }
  function showWaiting() {
    if (modalEl) modalEl.remove();
    var status = h('p', null, 'Your agent has the feedback. This page reloads when the next version is up.');
    modalEl = h('div', { class: 'modalbg' },
      h('div', { class: 'modal' }, h('h2', null, 'Sent ✓'), status,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: function () { location.reload(); } }, 'Reload now'))));
    ui.appendChild(modalEl);
    // Reload once a *different* launch answers (the old proxy may answer briefly while it shuts down).
    var started = Date.now();
    (function poll() {
      fetch('/__annotate/ping', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.boot && d.boot !== cfg.boot) { location.reload(); return; }
        setTimeout(poll, 2000);
      }).catch(function () {
        if (Date.now() - started > 3600000) { status.textContent = 'Still waiting. Reload when your agent says it is ready.'; return; }
        setTimeout(poll, 2000);
      });
    })();
  }

  /* ---------- render all ---------- */
  function render() { follow(); renderMarks(); }
  function renderAll() { renderBar(); renderMenu(); renderPanel(); renderHint(); renderMarks(); }

  /* ---------- init ---------- */
  function init() {
    document.head.appendChild(pageStyle);
    document.documentElement.appendChild(host);
    applyInFileVariant();

    // Events from our own UI and markers must never reach the page (slide decks listen on
    // document/window for clicks, keys, swipes and wheel). Stop them at our roots, in the
    // bubble phase so our own handlers still run first.
    var SHIELD = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'touchmove',
      'wheel', 'contextmenu', 'keydown', 'keyup', 'keypress'];
    SHIELD.forEach(function (t) {
      var opts = { passive: true };
      ui.addEventListener(t, function (e) { e.stopPropagation(); }, opts);
      layer.addEventListener(t, function (e) { e.stopPropagation(); }, opts);
    });
    // While annotating (Pin / Text / Area), the page itself should not react to touch or pointer input either.
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick'].forEach(function (t) {
      window.addEventListener(t, function (e) {
        if (state.mode !== 'browse' && !isOwn(e)) e.stopPropagation();
      }, true);
    });

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', schedule);
    // page scroll: just shift the layer. Scrolling inside a box (e.g. a dialog body) moves its marks, so re-place them.
    document.addEventListener('scroll', function (e) {
      follow();
      if (e.target !== document && e.target !== document.documentElement) schedule();
    }, { capture: true, passive: true });
    window.addEventListener('load', schedule);
    // slide/tab changes that animate (fade, slide) settle after the DOM change, so re-check when they end
    ['transitionend', 'animationend'].forEach(function (t) { document.addEventListener(t, schedule, true); });
    window.addEventListener('storage', function (e) {
      if (e.key === KEY) { store = loadStore(); renderAll(); }
    });

    if (window.ResizeObserver) new ResizeObserver(schedule).observe(document.body);
    new MutationObserver(function (ms) {
      if (ms.some(function (m) { return m.attributeName === 'open'; })) syncTop(); else schedule();
    }).observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'] // slide changes toggle these; open = dialogs
    });
    // a page popover or dialog that opens after ours sits above it in the top layer, so re-raise
    document.addEventListener('toggle', function (e) { if (e.target !== host) syncTop(); }, true);
    syncTop();

    renderAll();
    if (!store.author) askName();

    var focus = new URLSearchParams(location.search).get('uia-focus');
    if (focus) setTimeout(function () { focusComment(focus); }, 400);

    window.UIAnnotator = { version: VERSION, export: buildExport, text: buildText, config: cfg };
  }

  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
