// Gantt chart renderer (inline SVG). Produces four aligned pieces — corner,
// timeline header, task labels, chart body — so the header and labels can be
// sticky while the body scrolls. For printing, the pieces are combined into a
// single scalable SVG.

import { toISO, todayDay, dayOfWeek } from './calendar.js';
import { linkDrives } from './schedule.js';

export const ROW = 26;
const HEAD = 44;
const LABEL_W = 280;
const ZOOM_PX = { day: 26, week: 9, month: 3 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ymd = n => { const [y, m, d] = toISO(n).split('-').map(Number); return { y, m, d }; };
const dayOf = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000;

// Rows to draw, skipping those inside collapsed summaries.
function visible(plan, sched, hidden) {
  return sched.rows.map((r, i) => ({ r, t: plan.tasks[i] })).filter(({ r }) => !hidden.has(r.id));
}

function layout(sched, zoom, nRows) {
  const px = ZOOM_PX[zoom] || ZOOM_PX.day;
  let from = sched.startDay - 3;
  let to = sched.finishDay + 10;
  if (zoom !== 'day') { while (dayOfWeek(from) !== 1) from--; }
  if (zoom === 'month') {
    const a = ymd(from); from = dayOf(a.y, a.m, 1);
    const b = ymd(to); to = dayOf(b.y, b.m + 1, 1);
  }
  const width = Math.max(600, (to - from) * px);
  const height = Math.max(nRows, 1) * ROW;
  return { px, from, to, width, height, x: n => (n - from) * px };
}

function header(L, zoom, cal) {
  const out = [];
  out.push(`<rect class="g-head-bg" x="0" y="0" width="${L.width}" height="${HEAD}"/>`);
  // Top band: months (or years in month zoom)
  for (let n = L.from; n < L.to;) {
    const { y, m } = ymd(n);
    const next = zoom === 'month' ? dayOf(y + 1, 1, 1) : dayOf(y, m + 1, 1);
    const x1 = L.x(n), x2 = L.x(Math.min(next, L.to));
    const label = zoom === 'month' ? String(y) : `${MONTHS[m - 1]} ${y}`;
    out.push(`<line class="g-head-line" x1="${x1}" y1="0" x2="${x1}" y2="${HEAD}"/>`);
    if (x2 - x1 > 30) out.push(`<text class="g-head-text" x="${x1 + 4}" y="15">${label}</text>`);
    n = next;
  }
  // Bottom band
  out.push(`<line class="g-head-line" x1="0" y1="${HEAD / 2}" x2="${L.width}" y2="${HEAD / 2}"/>`);
  if (zoom === 'day') {
    for (let n = L.from; n < L.to; n++) {
      const x = L.x(n), { d } = ymd(n);
      out.push(`<text class="g-head-text small${cal.isWorkday(n) ? '' : ' muted'}" x="${x + L.px / 2}" y="${HEAD - 7}" text-anchor="middle">${d}</text>`);
    }
  } else if (zoom === 'week') {
    for (let n = L.from; n < L.to; n += 7) {
      const x = L.x(n), { m, d } = ymd(n);
      out.push(`<line class="g-head-line" x1="${x}" y1="${HEAD / 2}" x2="${x}" y2="${HEAD}"/>`);
      out.push(`<text class="g-head-text small" x="${x + 3}" y="${HEAD - 7}">${m}/${d}</text>`);
    }
  } else {
    for (let n = L.from; n < L.to;) {
      const { y, m } = ymd(n);
      const next = dayOf(y, m + 1, 1);
      const x = L.x(n);
      out.push(`<line class="g-head-line" x1="${x}" y1="${HEAD / 2}" x2="${x}" y2="${HEAD}"/>`);
      out.push(`<text class="g-head-text small" x="${x + 3}" y="${HEAD - 7}">${MONTHS[m - 1]}</text>`);
      n = next;
    }
  }
  return out.join('');
}

function labels(vis, selectedId) {
  const out = [`<rect class="g-label-bg" x="0" y="0" width="${LABEL_W}" height="${Math.max(vis.length, 1) * ROW}"/>`];
  vis.forEach(({ r, t }, i) => {
    const y = i * ROW;
    const x = 36 + r.level * 14;
    const twisty = r.summary
      ? `<text class="g-twisty" data-act="toggle" x="${x + 4}" y="${y + 17}" text-anchor="middle">${t.collapsed ? '▸' : '▾'}<title>${t.collapsed ? 'Expand' : 'Collapse'} (or double-click the row)</title></text>`
      : '';
    const cls = ['g-label', r.summary ? 'summary' : '', !r.summary && r.critical ? 'critical' : '', r.id === selectedId ? 'selected' : ''].join(' ');
    const warn = r.issues.length ? `<tspan class="g-warn" data-tip="${esc(r.issues.join('\n'))}">⚠</tspan> ` : '';
    const pin = r.pinned ? ' 📌' : '';
    out.push(`<g class="g-row" data-id="${r.id}">`
      + `<rect class="g-row-bg${r.id === selectedId ? ' selected' : ''}" x="0" y="${y}" width="${LABEL_W}" height="${ROW}"/>`
      + `<text class="g-rownum" x="26" y="${y + 17}" text-anchor="end">${r.row}</text>`
      + twisty
      + `<text class="${cls}" x="${x + 12}" y="${y + 17}">${warn}${esc(truncate(t.name || '(unnamed)', 32 - r.level * 2))}${pin}</text>`
      + `</g>`);
  });
  return out.join('');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, Math.max(n - 1, 4)) + '…' : s;
}

function body(sched, vis, hidden, L, selectedId) {
  const out = [];
  const rows = vis.map(v => v.r);
  // Row stripes and selection
  rows.forEach((r, i) => {
    out.push(`<rect class="g-row-bg${r.id === selectedId ? ' selected' : ''}${i % 2 ? ' odd' : ''}" data-id="${r.id}" x="0" y="${i * ROW}" width="${L.width}" height="${ROW}"/>`);
  });
  // Non-working days
  if (L.px >= 5) {
    for (let n = L.from; n < L.to; n++) {
      if (!sched.cal.isWorkday(n)) out.push(`<rect class="g-nonwork" x="${L.x(n)}" y="0" width="${L.px}" height="${L.height}"/>`);
    }
  }
  // Week / month grid lines
  for (let n = L.from; n < L.to; n++) {
    const { d } = ymd(n);
    if ((L.px >= 5 && dayOfWeek(n) === 1) || (L.px < 5 && d === 1)) {
      out.push(`<line class="g-grid" x1="${L.x(n)}" y1="0" x2="${L.x(n)}" y2="${L.height}"/>`);
    }
  }
  // Today
  const today = todayDay();
  if (today >= L.from && today < L.to) {
    const x = L.x(today) + L.px / 2;
    out.push(`<line class="g-today" x1="${x}" y1="0" x2="${x}" y2="${L.height}"><title>Today ${toISO(today)}</title></line>`);
  }

  const index = new Map(rows.map((r, i) => [r.id, i]));
  const geom = r => {
    const i = index.get(r.id);
    const top = i * ROW, mid = top + ROW / 2;
    if (r.milestone) { const x = L.x(r.pointDay); return { top, mid, x1: x - 6, x2: x + 6 }; }
    return { top, mid, x1: L.x(r.startDay), x2: L.x(r.finishDay + 1) };
  };

  // A task hidden in a collapsed group is represented by that group's bar
  const shown = id => { while (hidden.has(id)) id = sched.byId.get(id).parent; return sched.byId.get(id); };

  // Dependency arrows (drawn first so bars sit on top)
  const arrows = new Map(); // key -> { d, crit }; merged links are critical if any part is
  for (const s of sched.rows) {
    if (s.summary) continue;
    const r = shown(s.id);
    const g = geom(r);
    for (const { id: pid, type } of s.preds) {
      const p0 = sched.byId.get(pid), p = shown(pid);
      if (p === r) continue; // both ends inside the same collapsed group
      const key = `${p.id}>${r.id}:${type}`;
      const crit = p0.critical && s.critical && linkDrives(p0, s, type);
      if (arrows.has(key)) { arrows.get(key).crit ||= crit; continue; }
      const pg = geom(p);
      const ye = pg.mid, ys = g.mid;
      let d;
      if (type === 'SS') {
        // Start to start: out the left of p, in from the left of r
        const xl = Math.min(pg.x1, g.x1) - 8;
        d = `M${pg.x1},${ye} H${xl} V${ys} H${g.x1 - 1}`;
      } else if (type === 'FF') {
        // Finish to finish: out the right of p, in from the right of r
        const xr = Math.max(pg.x2, g.x2) + 8;
        d = `M${pg.x2},${ye} H${xr} V${ys} H${g.x2 + 1}`;
      } else {
        const xe = pg.x2, xs = g.x1;
        if (xs - xe >= 14) {
          d = `M${xe},${ye} H${xs - 8} V${ys} H${xs - 1}`;
        } else {
          const yb = ys > ye ? g.top : g.top + ROW;
          d = `M${xe},${ye} h7 V${yb} H${xs - 8} V${ys} H${xs - 1}`;
        }
      }
      arrows.set(key, { d, crit });
    }
  }
  // Critical links drawn last so they are not hidden under grey ones
  for (const { d, crit } of [...arrows.values()].sort((a, b) => a.crit - b.crit)) {
    out.push(`<path class="g-link${crit ? ' critical' : ''}" d="${d}" marker-end="url(#${crit ? 'arrow-crit' : 'arrow'})"/>`);
  }

  // FF arrows turn just right of the bar end, so labels there move further out
  const ffEnds = new Set();
  for (const r of sched.rows) for (const l of r.preds) if (l.type === 'FF') { ffEnds.add(shown(r.id).id); ffEnds.add(shown(l.id).id); }

  // Bars
  vis.forEach(({ r, t }) => {
    const g = geom(r);
    const tip = `<title>${esc(`${r.row}. ${t.name}\n${r.start}${r.milestone ? '' : ' → ' + r.finish}`
      + `${r.summary ? '' : `\n${r.duration} working day${r.duration === 1 ? '' : 's'}, float ${r.float ?? '?'}`}`
      + `${r.pct ? `\n${r.pct}% complete` : ''}${t.assignee ? `\n${t.assignee}` : ''}`
      + `${r.issues.length ? '\n⚠ ' + r.issues.join('\n⚠ ') : ''}`)}</title>`;
    const conflict = r.issues.length ? ' conflict' : '';
    let shape;
    if (r.summary) {
      const y = g.top + 8, h = 6, x1 = g.x1, x2 = Math.max(g.x2, x1 + 2);
      shape = `<path class="g-summary" d="M${x1},${y} H${x2} V${y + h + 5} L${x2 - 5},${y + h} H${x1 + 5} L${x1},${y + h + 5} Z"/>`;
    } else if (r.milestone) {
      const x = (g.x1 + g.x2) / 2, y = g.mid, s = 7;
      shape = `<path class="g-milestone${r.critical ? ' critical' : ''}${conflict}" d="M${x},${y - s} L${x + s},${y} L${x},${y + s} L${x - s},${y} Z"/>`;
    } else {
      const y = g.top + 6, h = ROW - 12, w = Math.max(g.x2 - g.x1, 2);
      const pw = w * r.pct / 100;
      shape = `<rect class="g-bar${r.critical ? ' critical' : ''}${conflict}" x="${g.x1}" y="${y}" width="${w}" height="${h}" rx="2"/>`
        + (pw > 0 ? `<rect class="g-progress${r.critical ? ' critical' : ''}" x="${g.x1}" y="${y + h / 2 - 2}" width="${pw}" height="4"/>` : '');
    }
    const note = t.assignee ? `<text class="g-bar-text" x="${g.x2 + (ffEnds.has(r.id) ? 14 : 6)}" y="${g.mid + 4}">${esc(t.assignee)}</text>` : '';
    out.push(`<g class="g-task" data-id="${r.id}">${shape}${note}${tip}</g>`);
  });
  return out.join('');
}

const DEFS = `<defs>
  <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="g-arrowhead" d="M0,0 L8,4 L0,8 Z"/></marker>
  <marker id="arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="g-arrowhead critical" d="M0,0 L8,4 L0,8 Z"/></marker>
</defs>`;

// Render into a container element. Returns nothing; call again on change.
export function renderGantt(container, plan, sched, { zoom = 'day', selectedId = null, hidden = new Set() } = {}) {
  const vis = visible(plan, sched, hidden);
  const L = layout(sched, zoom, vis.length);
  const H = L.height;
  container.innerHTML = `
    <div class="gantt-grid" style="grid-template-columns:${LABEL_W}px ${L.width}px">
      <div class="g-corner"><svg width="${LABEL_W}" height="${HEAD}"><rect class="g-head-bg" width="${LABEL_W}" height="${HEAD}"/>
        <text class="g-head-text" x="10" y="${HEAD - 10}">Task</text></svg></div>
      <div class="g-head"><svg width="${L.width}" height="${HEAD}">${header(L, zoom, sched.cal)}</svg></div>
      <div class="g-labels"><svg width="${LABEL_W}" height="${H}">${labels(vis, selectedId)}</svg></div>
      <div class="g-body"><svg width="${L.width}" height="${H}">${DEFS}${body(sched, vis, hidden, L, selectedId)}</svg></div>
    </div>`;
}

// Scroll so a given day is near the left edge of the chart.
export function scrollToDay(container, sched, zoom, day) {
  const L = layout(sched, zoom, 0);
  container.scrollLeft = Math.max(0, L.x(day) - 2 * L.px);
}

function wholeChart(plan, sched, zoom, hidden) {
  const vis = visible(plan, sched, hidden);
  const L = layout(sched, zoom, vis.length);
  const W = LABEL_W + L.width, H = HEAD + L.height;
  const inner = `${DEFS}
    <g transform="translate(${LABEL_W},${HEAD})">${body(sched, vis, hidden, L, null)}</g>
    <g transform="translate(0,${HEAD})">${labels(vis, null)}</g>
    <g transform="translate(${LABEL_W},0)">${header(L, zoom, sched.cal)}</g>
    <rect class="g-head-bg" width="${LABEL_W}" height="${HEAD}"/><text class="g-head-text" x="10" y="${HEAD - 10}">Task</text>`;
  return { W, H, inner };
}

// One SVG for printing / PDF, styled by the page's stylesheet.
export function ganttPrintSVG(plan, sched, zoom, hidden = new Set()) {
  const { W, H, inner } = wholeChart(plan, sched, zoom, hidden);
  return `<svg class="gantt-print" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet">${inner}</svg>`;
}

// A standalone SVG document (for rasterizing to PNG). `css` must carry every
// style the chart needs, since an SVG loaded as an image can't see the page.
export function ganttStandaloneSVG(plan, sched, zoom, css, hidden = new Set()) {
  const { W, H, inner } = wholeChart(plan, sched, zoom, hidden);
  return {
    width: W, height: H,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
      + `<style>${css}</style><rect width="${W}" height="${H}" fill="#fff"/>${inner}</svg>`,
  };
}
