// Deterministic timeline: everything on screen is a pure function of t (seconds). seek(t) is called per frame.
(function () {
  const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));
  const inout = (x) =>
    x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const back = (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const c1 = 1.70158,
      c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  };
  let SC = [];

  // "b2+0.5" → 0.5s after beat 2 starts; "b2e-0.3" → 0.3s before beat 2 ends; "end-1" → 1s before scene end; "3.2" → absolute in scene.
  function at(expr, sc) {
    if (expr == null || expr === '') return null;
    const e = String(expr).replace(/\s/g, '');
    const m = e.match(/^(?:b(\d+)(e?)|(end)|(-?[\d.]+))((?:[+-][\d.]+)*)$/);
    if (!m) throw new Error('bad time ' + expr);
    let base;
    if (m[1] != null) {
      const b = sc.beats[+m[1]];
      if (!b) throw new Error(sc.id + ': no beat ' + m[1]);
      base = m[2] ? b.at + b.dur : b.at;
    } else if (m[3]) base = sc.dur;
    else base = parseFloat(m[4]);
    for (const o of m[5].match(/[+-][\d.]+/g) || []) base += parseFloat(o);
    return base;
  }

  function prep(scEl, sc) {
    const q = (s) => Array.from(scEl.querySelectorAll(s));
    sc.el = scEl;
    sc.anims = q('[data-at],[data-out]').map((el) => ({
      el,
      a: el.dataset.at != null ? at(el.dataset.at, sc) : -99,
      o: at(el.dataset.out, sc),
      d: parseFloat(el.dataset.d || '0.55'),
      k: el.dataset.anim || 'up',
    }));
    sc.types = q('[data-type]').map((el) => ({
      el,
      a: at(el.dataset.typeAt, sc),
      s: el.dataset.type,
      cps: parseFloat(el.dataset.cps || '24'),
    }));
    sc.counts = q('[data-count]').map((el) => {
      const [f, t] = el.dataset.count.split(',').map(Number);
      return {
        el,
        f,
        t,
        a: at(el.dataset.countAt, sc),
        d: parseFloat(el.dataset.d || '1.2'),
        dec: +(el.dataset.dec || 0),
        suf: el.dataset.suf || '',
      };
    });
    sc.hls = q('[data-hl]').map((el) => {
      const [a, b] = el.dataset.hl.split('~');
      return { el, a: at(a, sc), b: at(b, sc) };
    });
    sc.cls = q('[data-cls]')
      .map((el) =>
        el.dataset.cls.split('|').map((p) => {
          const i = p.lastIndexOf(':');
          const [a, b] = p.slice(0, i).split('~');
          return { el, a: at(a, sc), b: b ? at(b, sc) : Infinity, c: p.slice(i + 1) };
        }),
      )
      .flat();
    sc.bars = q('[data-bar]').map((el) => ({
      el,
      a: at(el.dataset.barAt, sc),
      v: parseFloat(el.dataset.bar),
      d: parseFloat(el.dataset.d || '0.9'),
      dir: el.dataset.dir || 'h',
    }));
    const cur = scEl.querySelector('.cursor');
    sc.cursor = cur && {
      el: cur,
      ring: scEl.querySelector('.click-ring'),
      keys: (cur.dataset.path || '')
        .split('|')
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf(':');
          return { a: at(p.slice(0, i), sc), target: p.slice(i + 1).trim() };
        }),
      clicks: (cur.dataset.clicks || '')
        .split('|')
        .filter(Boolean)
        .map((p) => at(p, sc)),
      hide: at(cur.dataset.hide, sc),
    };
    sc.cam = q('[data-cam]').map((el) => ({
      el,
      keys: el.dataset.cam.split('|').map((p) => {
        const [tt, v] = p.split('@');
        const [s, x, y] = v.split(',').map(Number);
        return { a: at(tt, sc), s, x, y };
      }),
    }));
  }

  function pos(sc, target) {
    if (/^-?[\d.]+,-?[\d.]+$/.test(target)) {
      const [x, y] = target.split(',').map(Number);
      return { x, y };
    }
    const [sel, dx, dy] = target.split(/\s*~\s*/);
    const el = sc.el.querySelector(sel);
    if (!el) throw new Error(sc.id + ': cursor target missing ' + sel);
    const r = el.getBoundingClientRect(),
      base = sc.el.getBoundingClientRect();
    return {
      x: r.left - base.left + (dx ? parseFloat(dx) : r.width / 2),
      y: r.top - base.top + (dy ? parseFloat(dy) : r.height / 2),
    };
  }

  function apply(sc, t) {
    for (const x of sc.anims) {
      let p = ease((t - x.a) / x.d);
      if (x.o != null) p = Math.min(p, 1 - ease((t - x.o) / 0.4));
      const s = x.el.style;
      s.opacity = p;
      s.visibility = p <= 0.001 ? 'hidden' : 'visible';
      if (x.k === 'up') s.transform = `translateY(${(1 - p) * 22}px)`;
      else if (x.k === 'down') s.transform = `translateY(${(p - 1) * 22}px)`;
      else if (x.k === 'left') s.transform = `translateX(${(1 - p) * 40}px)`;
      else if (x.k === 'right') s.transform = `translateX(${(p - 1) * 40}px)`;
      else if (x.k === 'pop') {
        const b = back(Math.min(1, Math.max(0, (t - x.a) / x.d)));
        s.transform = `scale(${0.82 + 0.18 * (x.o != null && t > x.o ? 1 : b)})`;
      } else if (x.k === 'grow') s.transform = `scaleY(${p})`;
      else if (x.k === 'zoom') s.transform = `scale(${0.96 + 0.04 * p})`;
    }
    for (const x of sc.types) {
      const n =
        x.a == null ? x.s.length : Math.max(0, Math.min(x.s.length, Math.floor((t - x.a) * x.cps)));
      x.el.textContent = x.s.slice(0, n);
      x.el.classList.toggle(
        'typing',
        x.a != null && t >= x.a && n < x.s.length + 6 && t < x.a + x.s.length / x.cps + 0.6,
      );
    }
    for (const x of sc.counts) {
      const v = x.f + (x.t - x.f) * inout((t - x.a) / x.d);
      x.el.textContent = v.toFixed(x.dec) + x.suf;
    }
    for (const x of sc.hls) x.el.classList.toggle('hl', t >= x.a && t < x.b);
    const byEl = new Map();
    for (const x of sc.cls) {
      if (!byEl.has(x.el)) byEl.set(x.el, []);
      byEl.get(x.el).push(x);
    }
    for (const [el, list] of byEl) {
      const on = new Set();
      for (const x of list) if (t >= x.a && t < x.b) on.add(x.c);
      for (const x of list) el.classList.toggle(x.c, on.has(x.c));
    }
    for (const x of sc.bars) {
      const p = inout((t - x.a) / x.d) * x.v;
      if (x.dir === 'v') x.el.style.height = p + '%';
      else x.el.style.width = p + '%';
    }
    for (const c of sc.cam) {
      let cur = c.keys[0];
      let s = 1,
        x = 0,
        y = 0;
      for (let i = 0; i < c.keys.length; i++) {
        const k = c.keys[i],
          prev = c.keys[i - 1] || { s: 1, x: 0, y: 0, a: -1 };
        if (t >= k.a) {
          s = k.s;
          x = k.x;
          y = k.y;
          cur = k;
        }
        const m = Math.min(1.1, Math.max(0.01, k.a - (prev.a || 0)));
        if (t < k.a && t > k.a - m) {
          const p = inout(1 - (k.a - t) / m);
          s = prev.s + (k.s - prev.s) * p;
          x = prev.x + (k.x - prev.x) * p;
          y = prev.y + (k.y - prev.y) * p;
          break;
        }
        if (t < k.a) break;
      }
      c.el.style.transformOrigin = '0 0';
      c.el.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    }
    const cu = sc.cursor;
    if (cu && cu.keys.length) {
      let p = pos(sc, cu.keys[0].target);
      for (let i = 1; i < cu.keys.length; i++) {
        const k = cu.keys[i],
          prevT = cu.keys[i - 1].a,
          m = Math.min(0.85, Math.max(0.2, k.a - prevT));
        if (t >= k.a) {
          p = pos(sc, k.target);
          continue;
        }
        if (t > k.a - m) {
          const a = p,
            b = pos(sc, k.target),
            e = inout(1 - (k.a - t) / m);
          p = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e - Math.sin(Math.PI * e) * 26 };
        }
        break;
      }
      const vis = t >= cu.keys[0].a - 0.3 && (cu.hide == null || t < cu.hide);
      let press = 1,
        ringP = -1;
      for (const c of cu.clicks) {
        const d = t - c;
        if (d > -0.12 && d < 0.18) press = 0.84;
        if (d >= 0 && d < 0.55) ringP = d / 0.55;
      }
      cu.el.style.opacity = vis ? Math.min(1, (t - (cu.keys[0].a - 0.3)) / 0.3) : 0;
      cu.el.style.transform = `translate(${p.x}px, ${p.y}px) scale(${press})`;
      if (cu.ring) {
        cu.ring.style.opacity = ringP < 0 ? 0 : 1 - ringP;
        cu.ring.style.transform = `translate(${p.x}px, ${p.y}px) scale(${0.3 + ringP * 1.4})`;
      }
    }
  }

  window.__init = function (timings) {
    const els = Array.from(document.querySelectorAll('.scene'));
    SC = timings.scenes.map((t) => ({ ...t }));
    if (els.length !== SC.length)
      throw new Error(`scene count mismatch: html ${els.length} vs timings ${SC.length}`);
    SC.forEach((sc, i) => {
      if (els[i].id !== sc.id) throw new Error(`scene order: ${els[i].id} vs ${sc.id}`);
      prep(els[i], sc);
    });
    window.__total = timings.total;
    return SC.length;
  };

  const X = 0.4; // crossfade
  window.seek = function (T) {
    for (const sc of SC) {
      const lt = T - sc.start;
      const on = lt > -X && lt < sc.dur + X;
      sc.el.style.display = on ? 'block' : 'none';
      if (!on) continue;
      const fin = Math.min(1, (lt + X) / X),
        fout = Math.min(1, (sc.dur + X - lt) / X);
      const first = sc === SC[0],
        last = sc === SC[SC.length - 1];
      sc.el.style.opacity = Math.min(first ? 1 : fin, last ? 1 : fout);
      apply(sc, lt);
    }
    const g = document.getElementById('progress');
    if (g) g.style.width = (100 * T) / window.__total + '%';
  };
})();
