import { ic } from './kit.mjs';
export const COLORS = [
  '#137a5d',
  '#7a5af8',
  '#e04f16',
  '#2e90fa',
  '#c11574',
  '#0e9384',
  '#dc6803',
  '#475467',
];
export const initials = (n) =>
  n
    .split(' ')
    .filter((w) => /^[A-Z]/.test(w) && w !== 'Al')
    .map((w) => w[0])
    .slice(0, 2)
    .join('');
export const av = (n, c = 0, size = '') =>
  `<span class="av" style="background:${COLORS[c % COLORS.length]};${size}">${initials(n)}</span>`;
export const who = (n, sub, c = 0) =>
  `<div class="who">${av(n, c)}<div><b style="font-weight:600;color:#101828">${n}</b>${sub ? `<small>${sub}</small>` : ''}</div></div>`;
export const chip = (t, c = 'green', extra = '') =>
  `<span class="chip c-${c}" ${extra}>${t}</span>`;
export const tag = (t, cls = '') => `<span class="tag ${cls}">${t}</span>`;
// Swap element a for b at time `at` (both occupy the same grid cell).
export const swap = (at, a, b) =>
  `<span class="stack"><span data-out="${at}" data-anim="fade">${a}</span><span data-at="${at}" data-anim="pop" data-d="0.45">${b}</span></span>`;
export const F = (label, inner, o = {}) =>
  `<div class="field" ${o.attrs || ''} ${o.id ? `id="${o.id}"` : ''} ${o.hl ? `data-hl="${o.hl}"` : ''}><label>${label}</label>${inner}${o.hint ? `<div class="hint">${o.hint}</div>` : ''}</div>`;
export const I = (val, o = {}) =>
  `<div class="inp ${o.sel ? 'sel' : ''} ${o.cls || ''}" ${o.id ? `id="${o.id}"` : ''} ${o.focus ? `data-cls="${o.focus}:focus"` : ''}>${o.icon ? ic(o.icon, 'width="16" height="16" style="color:#667085;flex:none"') : ''}${o.type ? `<span data-type="${val}" data-type-at="${o.type}" ${o.cps ? `data-cps="${o.cps}"` : ''}></span>` : `<span class="${o.ph ? 'ph-t' : ''}">${val}</span>`}</div>`;
export const btn = (label, o = {}) =>
  `<span class="btn ${o.cls || ''}" ${o.id ? `id="${o.id}"` : ''} ${o.attrs || ''}>${o.icon ? ic(o.icon) : ''}${label}</span>`;
export const sw = (on = true, at = null) =>
  `<span class="sw ${on && !at ? 'on' : ''}" ${at ? `data-cls="${at}:on"` : ''}></span>`;
export const cb = (at, id = '') =>
  `<span class="cb" ${id ? `id="${id}"` : ''} ${at ? `data-cls="${at}:on"` : ''}>${ic('LuCheck', 'stroke-width="3"')}</span>`;
export const toast = (at, out, title, sub, icon = 'LuCircleCheck') =>
  `<div class="toast" data-at="${at}" ${out ? `data-out="${out}"` : ''} data-anim="up">${ic(icon)}<div><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div></div>`;
export const modal = (at, out, style, inner) =>
  `<div class="modal-bg" data-at="${at}" data-out="${out}" data-anim="fade" data-d="0.3"></div><div class="modal" data-at="${at}+0.05" data-out="${out}" data-anim="zoom" data-d="0.35" style="${style}">${inner}</div>`;
export const mhead = (title, sub) =>
  `<div class="mhead"><div><h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}</div><span class="mx">${ic('LuX')}</span></div>`;
export const scene = (id, inner, cls = '') =>
  `<section class="scene ${cls}" id="${id}">${inner}</section>`;
export const spark = (pts, color = '#1f9873') => {
  const max = Math.max(...pts),
    min = Math.min(...pts);
  const xy = pts
    .map((v, i) => `${(i / (pts.length - 1)) * 100},${28 - ((v - min) / (max - min || 1)) * 24}`)
    .join(' ');
  return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points="${xy}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
};
