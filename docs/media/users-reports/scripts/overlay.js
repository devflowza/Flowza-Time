// Recording overlay, injected into every page of the recording (top frame only): a visible mouse cursor and click ripple
// (headless Chromium draws none), the narration caption as a lower third, chapter cards, and a spotlight ring for pointing
// at part of the screen. Everything lives in a closed shadow root with pointer-events: none, so the app never sees it.
(() => {
  if (window.top !== window || window.__rec) return;
  const css = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: Inter, "Geist Variable", system-ui, sans-serif; }
    .cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; transform: translate(-100px, -100px); filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
    .ripple { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid rgba(16,185,129,.9); background: rgba(16,185,129,.18); animation: rip .55s ease-out forwards; }
    @keyframes rip { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.35); opacity: 0; } }
    .caption { position: absolute; left: 272px; bottom: 22px; max-width: 660px; padding: 12px 18px 13px; border-radius: 12px; background: rgba(12, 22, 18, .86); color: #fff; font-size: 19px; line-height: 1.38; font-weight: 500; letter-spacing: -.003em; box-shadow: 0 8px 28px rgba(0,0,0,.28); opacity: 0; transform: translateY(8px); transition: opacity .28s ease, transform .28s ease; }
    .caption.on { opacity: 1; transform: none; }
    .caption.wide { left: 50%; transform: translate(-50%, 8px); max-width: 980px; text-align: center; }
    .caption.wide.on { transform: translate(-50%, 0); }
    .card { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(1200px 700px at 30% 20%, #134e3a 0%, #0b2a20 55%, #071a14 100%); color: #ecfdf5; opacity: 0; transition: opacity .5s ease; }
    .card.on { opacity: 1; }
    .card .box { width: 980px; }
    .card .brand { display: flex; align-items: center; gap: 14px; font-size: 22px; font-weight: 600; color: #a7f3d0; letter-spacing: .01em; }
    .card .logo { width: 42px; height: 42px; border-radius: 11px; background: #10b981; color: #052e22; display: grid; place-items: center; font-weight: 800; font-size: 24px; }
    .card .kicker { margin-top: 46px; font-size: 18px; font-weight: 600; text-transform: uppercase; letter-spacing: .14em; color: #6ee7b7; }
    .card h1 { margin: 14px 0 0; font-size: 64px; line-height: 1.05; font-weight: 700; letter-spacing: -.025em; color: #fff; }
    .card p { margin: 22px 0 0; font-size: 24px; line-height: 1.45; color: #d1fae5; max-width: 860px; }
    .card ol { margin: 34px 0 0; padding: 0; list-style: none; display: grid; grid-template-columns: 1fr 1fr; gap: 14px 40px; }
    .card li { display: flex; gap: 14px; align-items: baseline; font-size: 23px; color: #ecfdf5; }
    .card li b { color: #34d399; font-weight: 700; min-width: 24px; }
    .card .rule { height: 3px; width: 88px; background: #34d399; border-radius: 2px; margin-top: 30px; }
    .spot { position: absolute; border-radius: 12px; border: 3px solid #10b981; box-shadow: 0 0 0 6px rgba(16,185,129,.22), 0 0 0 9999px rgba(3, 12, 9, .28); opacity: 0; transition: opacity .3s ease, left .45s ease, top .45s ease, width .45s ease, height .45s ease; }
    .spot.on { opacity: 1; }
    .spot .tag { position: absolute; left: -3px; top: -38px; padding: 5px 11px; border-radius: 8px; background: #10b981; color: #052e22; font-size: 16px; font-weight: 700; white-space: nowrap; }
  `;
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${css}</style><div class="layer">
    <div class="spot"><span class="tag"></span></div>
    <div class="card"><div class="box"></div></div>
    <div class="caption"></div>
    <svg class="cursor" viewBox="0 0 26 26"><path d="M4 2.5 L4 21 L9.2 16.4 L12.6 24 L16 22.5 L12.7 15 L20 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>
  </div>`;
  const $ = (s) => root.querySelector(s);
  // init scripts run before <html> exists: mount once it does, and stay its last child (above anything appended later)
  const mount = () => {
    if (!document.documentElement || host.isConnected) return;
    document.documentElement.appendChild(host);
    new MutationObserver(() => { if (host.nextSibling) document.documentElement.appendChild(host); }).observe(document.documentElement, { childList: true });
  };
  mount();
  document.addEventListener('DOMContentLoaded', mount);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let pos = { x: -100, y: -100 };
  window.__rec = {
    cursor(x, y) { pos = { x, y }; $('.cursor').style.transform = `translate(${x - 3}px, ${y - 2}px)`; },
    hideCursor() { $('.cursor').style.transform = 'translate(-100px, -100px)'; },
    ripple(x = pos.x, y = pos.y) { const r = document.createElement('div'); r.className = 'ripple'; r.style.left = `${x}px`; r.style.top = `${y}px`; $('.layer').appendChild(r); setTimeout(() => r.remove(), 700); },
    caption(text, wide = false) {
      const c = $('.caption');
      if (!text) { c.classList.remove('on'); return; }
      c.classList.toggle('wide', wide);
      c.textContent = text;
      c.classList.add('on');
    },
    card(spec) {
      const c = $('.card');
      if (!spec) { c.classList.remove('on'); return; }
      const brand = '<div class="brand"><div class="logo">F</div>FlowZa Time</div>';
      const items = spec.items ? `<ol>${spec.items.map((t, i) => `<li><b>${i + 1}</b>${esc(t)}</li>`).join('')}</ol>` : '';
      $('.card .box').innerHTML = `${brand}${spec.kicker ? `<div class="kicker">${esc(spec.kicker)}</div>` : ''}<h1>${esc(spec.title)}</h1>${spec.sub ? `<p>${esc(spec.sub)}</p>` : ''}${items}<div class="rule"></div>`;
      c.classList.add('on');
    },
    spot(rect, tag) {
      const s = $('.spot');
      if (!rect) { s.classList.remove('on'); return; }
      const pad = 8;
      Object.assign(s.style, { left: `${rect.x - pad}px`, top: `${rect.y - pad}px`, width: `${rect.width + 2 * pad}px`, height: `${rect.height + 2 * pad}px` });
      const t = $('.spot .tag');
      t.textContent = tag ?? '';
      t.style.display = tag ? '' : 'none';
      s.classList.add('on');
    },
  };
})();
