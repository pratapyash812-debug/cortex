"""Client script shipped with every exported site: theme switch, search page and graph page. No libraries, no network."""

SITE_JS = r"""
(function () {
  var root = document.documentElement;
  var btn = document.getElementById('theme');
  if (btn) btn.addEventListener('click', function () {
    var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('cortex-theme', root.dataset.theme); } catch (e) {}
  });
  var page = document.body.dataset.page;

  if (page === 'search') {
    var index = window.CORTEX_INDEX || [];
    var box = document.getElementById('q'), out = document.getElementById('results');
    var esc = function (s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var run = function () {
      var terms = box.value.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) { out.innerHTML = ''; return; }
      var hits = [];
      index.forEach(function (n) {
        var title = n.t.toLowerCase(), body = n.x.toLowerCase(), tags = n.g.join(' ').toLowerCase(), score = 0, pos = -1;
        for (var i = 0; i < terms.length; i++) {
          var t = terms[i], s = (title.indexOf(t) >= 0 ? 10 : 0) + (tags.indexOf(t) >= 0 ? 5 : 0) + (body.indexOf(t) >= 0 ? 1 : 0);
          if (!s) return;
          score += s;
          if (pos < 0) pos = body.indexOf(t);
        }
        hits.push({ n: n, score: score, snip: pos >= 0 ? n.x.slice(Math.max(0, pos - 50), pos + 120) : n.x.slice(0, 120) });
      });
      hits.sort(function (a, b) { return b.score - a.score; });
      out.innerHTML = hits.length ? hits.slice(0, 50).map(function (h) {
        return '<div class="hit"><a href="' + h.n.u + '">' + esc(h.n.t) + '</a><p>' + esc(h.snip) + '</p></div>';
      }).join('') : '<p class="meta">No notes match.</p>';
    };
    box.addEventListener('input', run);
    var q = new URLSearchParams(location.search).get('q');
    if (q) { box.value = q; run(); }
  }

  if (page === 'graph' && window.CORTEX_GRAPH) {
    var g = window.CORTEX_GRAPH, svg = document.getElementById('graph'), NS = 'http://www.w3.org/2000/svg', W = 900, H = 600;
    var groups = {}, byId = {};
    g.nodes.forEach(function (n, i) {
      groups[n.group] = groups[n.group] === undefined ? Object.keys(groups).length : groups[n.group];
      n.x = W / 2 + 200 * Math.cos(i * 2.4); n.y = H / 2 + 200 * Math.sin(i * 2.4); n.vx = 0; n.vy = 0; byId[n.id] = n;
    });
    var links = g.edges.map(function (e) { return { s: byId[e.s], t: byId[e.t] }; }).filter(function (l) { return l.s && l.t; });
    for (var step = 0; step < 300; step++) {
      var k = 1 - step / 300;
      for (var i = 0; i < g.nodes.length; i++) for (var j = i + 1; j < g.nodes.length; j++) {
        var a = g.nodes[i], b = g.nodes[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01, f = 2600 / d2, d = Math.sqrt(d2);
        a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
      }
      links.forEach(function (l) {
        var dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - 70) * 0.02;
        l.s.vx += dx / d * f; l.s.vy += dy / d * f; l.t.vx -= dx / d * f; l.t.vy -= dy / d * f;
      });
      g.nodes.forEach(function (n) {
        n.vx += (W / 2 - n.x) * 0.004; n.vy += (H / 2 - n.y) * 0.004;
        n.x += Math.max(-20, Math.min(20, n.vx)) * k; n.y += Math.max(-20, Math.min(20, n.vy)) * k; n.vx *= 0.6; n.vy *= 0.6;
      });
    }
    var xs = g.nodes.map(function (n) { return n.x; }), ys = g.nodes.map(function (n) { return n.y; });
    var x0 = Math.min.apply(null, xs) - 60, x1 = Math.max.apply(null, xs) + 60, y0 = Math.min.apply(null, ys) - 30, y1 = Math.max.apply(null, ys) + 30;
    if (g.nodes.length) svg.setAttribute('viewBox', x0 + ' ' + y0 + ' ' + (x1 - x0) + ' ' + (y1 - y0));
    var el = function (name, attrs) { var e = document.createElementNS(NS, name); for (var key in attrs) e.setAttribute(key, attrs[key]); return e; };
    links.forEach(function (l) { svg.appendChild(el('line', { x1: l.s.x, y1: l.s.y, x2: l.t.x, y2: l.t.y })); });
    g.nodes.forEach(function (n) {
      var a = el('a', { href: n.id }), hue = (groups[n.group] * 67) % 360;
      a.appendChild(el('circle', { cx: n.x, cy: n.y, r: 6, fill: 'hsl(' + hue + ',60%,55%)' }));
      var t = el('text', { x: n.x, y: n.y + 17, 'text-anchor': 'middle' }); t.textContent = n.label; a.appendChild(t);
      var title = el('title', {}); title.textContent = n.group; a.appendChild(title);
      svg.appendChild(a);
    });
  }
})();
"""
