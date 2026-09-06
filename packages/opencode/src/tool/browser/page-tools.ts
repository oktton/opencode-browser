/**
 * JavaScript meta-tools injected into page context for agent use.
 *
 * __data(type?)  — embedded structured data (ld+json / microdata / og meta)
 * __q(n)         — [N] index → HTMLElement (bridge from pruned DOM to real DOM)
 * __find(s, tag?, n?) — full-text search across text + all attributes, optional tag filter and subtree scope
 *
 * Return values are auto-serialized: any HTMLElement in the result is replaced
 * with a lean { index, tagName, textContent, attrs, ... } shape. `index` bridges
 * back to browser_click / browser_input so actions stay on the instrumented path.
 */

const HL_ATTR = 'data-hl-idx';

export const PAGE_TOOLS_SCRIPT = `
(function() {
  if (window.__data) return; // already injected

  // Attributes worth carrying in serialized output; everything else is dropped.
  var __KEEP = ['id', 'class', 'aria-label', 'title', 'alt', 'role', 'type', 'name', 'placeholder', 'itemprop'];

  window.__attrs = function(el) {
    var out = {};
    for (var i = 0; i < __KEEP.length; i++) {
      var k = __KEEP[i];
      if (!el.hasAttribute(k)) continue;
      var v = el.getAttribute(k);
      if (!v) continue;
      var cap = k === 'class' ? 80 : 200;
      out[k] = v.length > cap ? v.slice(0, cap) + '…' : v;
    }
    // Short data-* values often carry the answer (data-rating="4.6"); long ones are payload blobs.
    var all = el.attributes;
    for (var j = 0; j < all.length; j++) {
      var a = all[j];
      if (a.name.indexOf('data-') !== 0 || a.name === '${HL_ATTR}') continue;
      if (a.value && a.value.length <= 40) out[a.name] = a.value;
    }
    return out;
  };

  // Single definition of the serialized element shape, shared by __enrich and __serialize.
  window.__shape = function(el) {
    var hl = el.closest('[${HL_ATTR}]');
    var out = {
      index: hl ? parseInt(hl.getAttribute('${HL_ATTR}')) : null,
      tagName: el.tagName,
      textContent: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      attrs: __attrs(el),
      childElementCount: el.childElementCount,
    };
    // Form controls only — li.value / meter.value etc. are numbers and just add noise.
    if (typeof el.value === 'string' && el.value !== '') out.value = el.value;
    if ('checked' in el) out.checked = el.checked;
    if ('selected' in el) out.selected = el.selected;
    if (el.disabled) out.disabled = true;
    if (el.href) out.href = el.href;
    return out;
  };

  // Attach .index / .attrs so elements read the same way in-page as they serialize.
  window.__enrich = function(el) {
    if (!el || el.__enriched) return el;
    var s = __shape(el);
    el.index = s.index;
    el.attrs = s.attrs;
    el.__enriched = true;
    return el;
  };

  // Cap depth, array length and string length so embedded data can't blow the output budget.
  // Elision is always visible, so a trimmed field never reads as a complete one.
  window.__shrink = function(v, d) {
    if (typeof v === 'string') return v.length > 150 ? v.slice(0, 150) + '…' : v;
    if (Array.isArray(v)) {
      var head = v.slice(0, 5).map(function(x) { return __shrink(x, d + 1); });
      return v.length > 5 ? head.concat(['… ' + (v.length - 5) + ' more of ' + v.length]) : head;
    }
    if (v && typeof v === 'object') {
      if (d >= 3) return '[…]';
      var o = {};
      for (var k in v) if (v.hasOwnProperty(k)) o[k] = __shrink(v[k], d + 1);
      return o;
    }
    return v;
  };

  window.__data = function(type) {
    var re = type ? new RegExp(type, 'i') : null;
    var out = [];
    var push = function(o) {
      if (!o || typeof o !== 'object' || out.length >= 30) return;
      if (Array.isArray(o)) { o.forEach(push); return; }
      if (o['@graph']) { push(o['@graph']); return; }
      if (re && !re.test(String(o['@type'] || ''))) return;
      out.push(__shrink(o, 0));
    };

    // 1. JSON-LD — the richest source, and the only one with unambiguous field names.
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      var parsed = null;
      try { parsed = JSON.parse(scripts[i].textContent); } catch (e) {} // page JSON is often malformed
      push(parsed);
    }

    // 2. Microdata — common where JSON-LD is absent.
    var scopes = document.querySelectorAll('[itemscope]');
    for (var s = 0; s < scopes.length && out.length < 30; s++) {
      var scope = scopes[s];
      if (scope.parentElement && scope.parentElement.closest('[itemscope]')) continue; // top-level only
      var itemtype = scope.getAttribute('itemtype') || '';
      if (re && !re.test(itemtype)) continue;
      var item = { '@type': itemtype.split('/').pop() || 'Item' };
      var props = scope.querySelectorAll('[itemprop]');
      for (var p = 0; p < props.length && p < 40; p++) {
        var prop = props[p];
        if (prop.closest('[itemscope]') !== scope) continue; // skip nested scopes
        var val = prop.getAttribute('content') || prop.getAttribute('datetime') || prop.textContent || '';
        item[prop.getAttribute('itemprop')] = String(val).replace(/\\s+/g, ' ').trim().slice(0, 200);
      }
      out.push(item);
    }

    // 3. og/meta — thin, but a reliable last resort for title/price/description.
    if (!re || re.test('PageMeta')) {
      var metas = document.querySelectorAll('meta[property^="og:"], meta[property^="product:"], meta[name^="twitter:"], meta[name="description"]');
      if (metas.length > 0) {
        var meta = { '@type': 'PageMeta' };
        for (var m = 0; m < metas.length; m++) {
          var key = metas[m].getAttribute('property') || metas[m].getAttribute('name');
          var content = metas[m].getAttribute('content');
          if (key && content) meta[key] = content.slice(0, 200);
        }
        out.push(meta);
      }
    }

    return out;
  };

  window.__q = function(n) {
    return __enrich(document.querySelector('[${HL_ATTR}="' + n + '"]'));
  };

  window.__find = function(pattern, tag, n) {
    // __find(pattern, tag?, n?) — pattern: regex string, tag: tag name filter, n: scope element
    if (typeof tag === 'number') { n = tag; tag = undefined; }
    var root = n !== undefined ? __q(n) : document.body;
    if (!root) return [];
    var re = pattern ? new RegExp(pattern, 'i') : null;
    var tagFilter = tag ? tag.toLowerCase() : null;
    var limit = 20;
    var results = [];
    var seen = new Set();
    var test = function(text) { return re && re.test(text); };
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode()) && results.length < limit) {
      if (node.nodeType === 3 && re) {
        var parent = node.parentElement;
        if (!parent || seen.has(parent)) continue;
        if (tagFilter && parent.tagName.toLowerCase() !== tagFilter) continue;
        if (test(node.textContent || '')) {
          seen.add(parent); results.push(__enrich(parent));
        }
      } else if (node.nodeType === 1) {
        if (seen.has(node)) continue;
        var el = node;
        if (tagFilter && el.tagName.toLowerCase() !== tagFilter) continue;
        if (!re) { seen.add(el); results.push(__enrich(el)); continue; }
        var found = false;
        var attrs = el.attributes;
        for (var i = 0; !found && i < attrs.length; i++) {
          if (test(attrs[i].value)) found = true;
        }
        if (!found) {
          var props = [el.value, el.href, el.src, el.action, el.dataset && Object.values(el.dataset).join(' ')].filter(Boolean);
          for (var i = 0; !found && i < props.length; i++) {
            if (test(String(props[i]))) found = true;
          }
        }
        if (found) { seen.add(el); results.push(__enrich(el)); }
      }
    }
    return results;
  };

  window.__classes = function(el) {
    var c = el.getAttribute('class');
    return c ? c.trim().split(/\\s+/).slice(0, 12) : [];
  };

  // Jaccard-ish overlap; -1 means "neither side has anything to compare on".
  window.__overlap = function(a, b) {
    if (a.length === 0 && b.length === 0) return -1;
    var set = {};
    for (var i = 0; i < a.length; i++) set[a[i]] = 1;
    var hit = 0;
    for (var j = 0; j < b.length; j++) if (set[b[j]]) hit++;
    return hit / Math.max(a.length, b.length);
  };

  window.__childTags = function(el) {
    var t = [];
    for (var i = 0; i < el.children.length && i < 16; i++) t.push(el.children[i].tagName);
    return t;
  };

  // Do two elements look like instances of the same record type?
  window.__similar = function(a, b) {
    if (a.tagName !== b.tagName) return false;
    var co = __overlap(__classes(a), __classes(b));
    if (co >= 0.5) return true;   // class lists agree — the common case
    if (co !== -1) return false;  // both have classes but they disagree
    // No classes to compare (tr, li, article): shape alone is weak — "tr > td" matches
    // footer and "load more" rows too — so also require comparable subtree size.
    if (__overlap(__childTags(a), __childTags(b)) < 0.6) return false;
    var na = a.getElementsByTagName('*').length + 1;
    var nb = b.getElementsByTagName('*').length + 1;
    return Math.max(na, nb) / Math.min(na, nb) <= 2.5;
  };

  // Index-free XPath: with no [i] predicates it matches every structurally parallel node.
  window.__path = function(el) {
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1) {
      parts.unshift(n.tagName.toLowerCase());
      n = n.parentElement;
    }
    return '/' + parts.join('/');
  };

  window.__parallel = function(el) {
    var out = [];
    try {
      var r = document.evaluate(__path(el), document, null, 7, null); // ORDERED_NODE_SNAPSHOT_TYPE
      for (var i = 0; i < r.snapshotLength && i < 500; i++) out.push(r.snapshotItem(i));
    } catch (e) {} // namespaced (SVG) paths can throw — fall back to sibling comparison
    return out;
  };

  // No anchor: pick the container whose children form the largest similar group.
  window.__recordsBlind = function() {
    var best = [];
    var all = document.body ? document.body.querySelectorAll('*') : [];
    for (var i = 0; i < all.length && i < 4000; i++) {
      var kids = all[i].children;
      if (kids.length < 3 || kids.length > 200) continue;
      var g = [kids[0]];
      for (var j = 1; j < kids.length; j++) if (__similar(kids[0], kids[j])) g.push(kids[j]);
      if (g.length > best.length && (g[0].textContent || '').trim().length > 20) best = g;
    }
    return best.map(__enrich);
  };

  window.__records = function(anchor) {
    // Accept a whole __find() result: its first hit is often intro text or a nav item
    // rather than a list member, so try the candidates and keep the largest group.
    if (Array.isArray(anchor)) {
      var best = [];
      for (var c = 0; c < anchor.length && c < 5; c++) {
        var got = __records(anchor[c]);
        if (got.length > best.length) best = got;
      }
      return best;
    }
    var el = anchor && anchor.nodeType === 1 ? anchor : typeof anchor === 'number' ? __q(anchor) : null;
    if (!el) return __recordsBlind();

    // Primary: find structurally parallel nodes, then the level at which they diverge.
    var matches = __parallel(el);
    if (matches.length >= 2) {
      // The record is the highest ancestor still uniquely owned by this match.
      var record = el;
      var up = 0;
      var probe = el;
      while (probe.parentElement && probe !== document.body) {
        probe = probe.parentElement;
        var under = 0;
        for (var i = 0; i < matches.length; i++) if (probe.contains(matches[i])) under++;
        if (under > 1) break; // diverged: this ancestor holds several records
        record = probe;
        up++;
      }
      // Every match sits at the same depth, so each one's record is its ancestor that many
      // levels up. Walking each match independently — rather than collecting one container's
      // children — keeps grid layouts working, where records split across repeating row wrappers.
      var group = [];
      var seen = new Set();
      for (var m = 0; m < matches.length; m++) {
        var r = matches[m];
        for (var u = 0; u < up && r; u++) r = r.parentElement;
        // Depth gives the level; similarity still has to gate the type — a parallel path
        // can land on a different kind of row at the same depth.
        if (r && !seen.has(r) && (r === record || __similar(record, r))) { seen.add(r); group.push(r); }
      }
      // Recover variants the strict path missed (extra wrapper, promo badge, ad card).
      var parents = [];
      for (var g = 0; g < group.length; g++)
        if (group[g].parentElement && parents.indexOf(group[g].parentElement) === -1) parents.push(group[g].parentElement);
      for (var pi = 0; pi < parents.length && pi < 50; pi++) {
        var kids = parents[pi].children;
        for (var ki = 0; ki < kids.length; ki++)
          if (!seen.has(kids[ki]) && __similar(record, kids[ki])) { seen.add(kids[ki]); group.push(kids[ki]); }
      }
      if (group.length >= 2) {
        group.sort(function(a, b) { return a.compareDocumentPosition(b) & 4 ? -1 : 1; }); // document order
        return group.map(__enrich);
      }
    }

    // Fallback: walk up comparing siblings, keep the deepest level that still explains most repetition.
    var levels = [];
    var cur = el;
    for (var d = 0; d < 8 && cur && cur.parentElement && cur !== document.body; d++) {
      var kids2 = cur.parentElement.children;
      var g2 = [];
      for (var k = 0; k < kids2.length; k++)
        if ((kids2[k] === cur || __similar(cur, kids2[k])) && (kids2[k].textContent || '').trim()) g2.push(kids2[k]);
      if (g2.length >= 2) levels.push(g2);
      cur = cur.parentElement;
    }
    if (levels.length === 0) return [];
    var max = 0;
    for (var a2 = 0; a2 < levels.length; a2++) if (levels[a2].length > max) max = levels[a2].length;
    for (var b2 = 0; b2 < levels.length; b2++)
      if (levels[b2].length >= max * 0.7) return levels[b2].map(__enrich);
    return [];
  };

  // Compressed structural view of one element, with [N] markers kept for browser_click.
  window.__skeleton = function(el, maxDepth) {
    var node = el && el.nodeType === 1 ? el : typeof el === 'number' ? __q(el) : null;
    if (!node) return '(no element)';
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1 };
    var limit = maxDepth === undefined ? 4 : maxDepth;
    var lines = [];
    var walk = function(n, depth) {
      if (n.nodeType !== 1 || depth > limit || lines.length >= 80 || SKIP[n.tagName]) return;
      var s = n.tagName.toLowerCase();
      var id = n.getAttribute('id');
      if (id) s += '#' + id.slice(0, 40);
      var cls = n.getAttribute('class');
      if (cls) s += '.' + cls.trim().split(/\\s+/).slice(0, 3).join('.').slice(0, 60);
      var hl = n.getAttribute('${HL_ATTR}');
      if (hl) s += ' [' + hl + ']';
      var marks = [];
      var keys = ['itemprop', 'aria-label', 'role', 'alt', 'title', 'datetime'];
      for (var k = 0; k < keys.length; k++) {
        var v = n.getAttribute(keys[k]);
        if (v) marks.push(keys[k] + '="' + v.slice(0, 60) + '"');
      }
      if (n.getAttribute('href')) marks.push('href');
      var own = '';
      for (var c = 0; c < n.childNodes.length; c++)
        if (n.childNodes[c].nodeType === 3) own += n.childNodes[c].textContent;
      own = own.replace(/\\s+/g, ' ').trim().slice(0, 80);
      lines.push(new Array(depth + 1).join('  ') + s + (marks.length ? ' ' + marks.join(' ') : '') + (own ? '  "' + own + '"' : ''));
      var kids = n.children;
      for (var q = 0; q < kids.length && q < 12; q++) walk(kids[q], depth + 1);
      if (kids.length > 12) lines.push(new Array(depth + 2).join('  ') + '… ' + (kids.length - 12) + ' more');
    };
    walk(node, 0);
    return lines.join('\\n');
  };

  window.__serialize = function(val) {
    if (val == null) return val;
    if (val instanceof HTMLElement) return __shape(val);
    if (Array.isArray(val)) return val.map(window.__serialize);
    if (val && typeof val === 'object' && val.constructor === Object) {
      var out = {};
      for (var k in val) {
        if (val.hasOwnProperty(k)) out[k] = window.__serialize(val[k]);
      }
      return out;
    }
    return val;
  };
})();
`;

/**
 * Wrap agent script so that:
 * 1. Page tools are injected if not already present
 * 2. Return value is auto-serialized (elements → lean { index, tagName, ... } shape)
 */
export function wrapScript(script: string): string {
  return `(function() {
  ${PAGE_TOOLS_SCRIPT}
  var __result = (function() { ${script} }).call(document.documentElement);
  return __serialize(__result);
})()`;
}
