// PERT / network diagram (activity on node). Each task is a box with its
// dates, duration and float; arrows are dependencies (SS and FF labelled);
// the critical path is red. Columns are dependency depth: a task sits one
// column right of its deepest predecessor. Rows within a column are ordered
// by a few barycenter sweeps to reduce crossings.
//
// A collapsed summary is drawn as one node standing in for its subtasks, as
// in the Gantt chart. Expanded summaries are not drawn (their subtasks are).

import { linkDrives } from './schedule.js';
import { esc } from './gantt.js';

const W = 200, H = 84, GAP_X = 64, GAP_Y = 22, PAD = 20;
const SWEEPS = 6;

function shortDate(n) {
  return new Date(n * 86400000).toLocaleDateString(undefined, { timeZone: 'UTC', year: '2-digit', month: 'numeric', day: 'numeric' });
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Nodes, edges and positions. Exported for tests.
export function pertLayout(plan, sched, hidden = new Set()) {
  const shown = id => { while (hidden.has(id)) id = sched.byId.get(id).parent; return sched.byId.get(id); };
  const taskOf = new Map(plan.tasks.map(t => [t.id, t]));
  const nodes = sched.rows.filter(r => !hidden.has(r.id) && (!r.summary || taskOf.get(r.id).collapsed));
  const isNode = new Set(nodes.map(r => r.id));

  // Edges between drawn nodes, merged where a collapsed group stands in
  const edges = new Map();
  for (const s of sched.rows) {
    if (s.summary) continue;
    const b = shown(s.id);
    for (const { id, type } of s.preds) {
      const p0 = sched.byId.get(id), a = shown(id);
      if (a === b || !isNode.has(a.id) || !isNode.has(b.id)) continue;
      const key = `${a.id}>${b.id}:${type}`;
      const crit = p0.critical && s.critical && linkDrives(p0, s, type);
      if (edges.has(key)) edges.get(key).crit ||= crit;
      else edges.set(key, { from: a.id, to: b.id, type, crit });
    }
  }
  const E = [...edges.values()];
  const preds = new Map(nodes.map(r => [r.id, []])), succs = new Map(nodes.map(r => [r.id, []]));
  for (const e of E) { preds.get(e.to).push(e.from); succs.get(e.from).push(e.to); }

  // Column = longest path from a start node (Kahn order; nodes in a cycle
  // keep whatever depth they reached)
  const col = new Map(nodes.map(r => [r.id, 0]));
  const indeg = new Map(nodes.map(r => [r.id, new Set(preds.get(r.id)).size]));
  const queue = nodes.filter(r => indeg.get(r.id) === 0).map(r => r.id);
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    seen.add(id);
    for (const sid of new Set(succs.get(id))) {
      col.set(sid, Math.max(col.get(sid), col.get(id) + 1));
      indeg.set(sid, indeg.get(sid) - 1);
      if (indeg.get(sid) === 0) queue.push(sid);
    }
  }

  // Order within columns: critical tasks always first, so the critical path
  // runs along the top; the rest start in plan order and are arranged by
  // barycenter sweeps to reduce crossings
  const ncol = Math.max(0, ...col.values()) + 1;
  const columns = Array.from({ length: ncol }, () => []);
  const critFirst = (a, b) => (sched.byId.get(b).critical === true) - (sched.byId.get(a).critical === true);
  for (const r of nodes) columns[col.get(r.id)].push(r.id);
  columns.forEach(c => c.sort((a, b) => critFirst(a, b) || sched.byId.get(a).row - sched.byId.get(b).row));
  const pos = new Map();
  const index = () => columns.forEach(c => c.forEach((id, i) => pos.set(id, i)));
  index();
  const bary = (id, nbrs) => {
    const ps = nbrs.get(id).map(n => pos.get(n));
    return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : pos.get(id);
  };
  for (let k = 0; k < SWEEPS; k++) {
    const down = k % 2 === 0;
    const order = down ? columns.slice(1) : columns.slice(0, -1).reverse();
    for (const c of order) {
      const key = new Map(c.map(id => [id, bary(id, down ? preds : succs)]));
      c.sort((a, b) => critFirst(a, b) || key.get(a) - key.get(b) || pos.get(a) - pos.get(b));
      c.forEach((id, i) => pos.set(id, i));
    }
  }
  index();

  const xy = new Map();
  columns.forEach((c, ci) => c.forEach((id, ri) => xy.set(id, { x: PAD + ci * (W + GAP_X), y: PAD + ri * (H + GAP_Y) })));
  const rowsMax = Math.max(1, ...columns.map(c => c.length));
  return {
    nodes, edges: E, xy,
    width: Math.max(600, PAD * 2 + ncol * W + (ncol - 1) * GAP_X),
    height: PAD * 2 + rowsMax * H + (rowsMax - 1) * GAP_Y,
  };
}

function nodeSVG(r, t, { x, y }, selectedId) {
  const cls = ['pt-node', r.summary ? 'summary' : '', !r.summary && r.critical ? 'critical' : '',
    r.issues.length ? 'conflict' : '', r.id === selectedId ? 'selected' : ''].filter(Boolean).join(' ');
  const title = `${r.summary ? '▸ ' : r.milestone ? '◆ ' : ''}${t.name || '(unnamed)'}`;
  const dur = r.milestone ? 'Milestone' : `${r.duration} day${r.duration === 1 ? '' : 's'}`;
  const float = r.summary || r.float === null ? '' : `Float ${r.float}`;
  const who = [t.assignee, r.pct ? `${r.pct}%` : ''].filter(Boolean).join(' · ');
  const warn = r.issues.length ? `<text class="pt-warn" x="${W - 8}" y="17" text-anchor="end">⚠</text>` : '';
  const tip = `${r.row}. ${t.name}\n${r.start}${r.milestone ? '' : ' → ' + r.finish}`
    + (r.summary ? '\nCollapsed group (double-click to expand)' : '')
    + (r.issues.length ? '\n⚠ ' + r.issues.join('\n⚠ ') : '');
  return `<g class="${cls}" data-id="${r.id}" transform="translate(${x},${y})"><title>${esc(tip)}</title>`
    + `<rect class="pt-box" width="${W}" height="${H}" rx="4"/>`
    + `<path class="pt-head" d="M0,4 a4,4 0 0 1 4,-4 H${W - 4} a4,4 0 0 1 4,4 V24 H0 Z"/>`
    + `<line class="pt-rule" x1="0" y1="24" x2="${W}" y2="24"/>`
    + `<text class="pt-num" x="8" y="17">${r.row}</text>`
    + `<text class="pt-title" x="30" y="17">${esc(truncate(title, 24))}</text>${warn}`
    + `<text class="pt-text" x="8" y="42">Start ${shortDate(r.startDay)}</text>`
    + `<text class="pt-text" x="${W - 8}" y="42" text-anchor="end">Finish ${shortDate(r.finishDay)}</text>`
    + `<text class="pt-text" x="8" y="59">${dur}</text>`
    + `<text class="pt-text${!r.summary && r.critical ? ' crit' : ''}" x="${W - 8}" y="59" text-anchor="end">${float}</text>`
    + `<text class="pt-text muted" x="8" y="76">${esc(truncate(who, 30))}</text>`
    + `</g>`;
}

function edgeSVG(e, xy) {
  const a = xy.get(e.from), b = xy.get(e.to);
  const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2;
  const bend = Math.max(30, (x2 - x1) / 2);
  const d = x2 > x1
    ? `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
    // Backward (only possible in a cycle): loop under the boxes
    : `M${x1},${y1} C${x1 + 60},${y1 + H} ${x2 - 60},${y2 + H} ${x2},${y2}`;
  const label = e.type === 'FS' ? '' : (() => {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    return `<rect class="pt-tag-bg" x="${mx - 12}" y="${my - 8}" width="24" height="15" rx="3"/>`
      + `<text class="pt-tag${e.crit ? ' critical' : ''}" x="${mx}" y="${my + 3.5}" text-anchor="middle">${e.type}</text>`;
  })();
  return `<path class="pt-link${e.crit ? ' critical' : ''}" d="${d}" marker-end="url(#${e.crit ? 'pt-arrow-crit' : 'pt-arrow'})"/>${label}`;
}

const DEFS = `<defs>
  <marker id="pt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="pt-arrowhead" d="M0,0 L8,4 L0,8 Z"/></marker>
  <marker id="pt-arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="pt-arrowhead critical" d="M0,0 L8,4 L0,8 Z"/></marker>
</defs>`;

function chart(plan, sched, hidden, selectedId) {
  const L = pertLayout(plan, sched, hidden);
  const taskOf = new Map(plan.tasks.map(t => [t.id, t]));
  // Critical edges last so they sit on top
  const edges = [...L.edges].sort((a, b) => a.crit - b.crit).map(e => edgeSVG(e, L.xy)).join('');
  const nodes = L.nodes.map(r => nodeSVG(r, taskOf.get(r.id), L.xy.get(r.id), selectedId)).join('');
  const empty = L.nodes.length ? '' : `<text class="pt-text muted" x="${PAD}" y="${PAD + 14}">No tasks to show.</text>`;
  return { width: L.width, height: L.height, inner: `${DEFS}${edges}${nodes}${empty}` };
}

export function renderPert(container, plan, sched, { selectedId = null, hidden = new Set() } = {}) {
  const { width, height, inner } = chart(plan, sched, hidden, selectedId);
  container.innerHTML = `<svg class="pert" width="${width}" height="${height}">${inner}</svg>`;
}

export function pertPrintSVG(plan, sched, hidden = new Set()) {
  const { width, height, inner } = chart(plan, sched, hidden, null);
  return `<svg class="gantt-print pert" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet">${inner}</svg>`;
}

export function pertStandaloneSVG(plan, sched, css, hidden = new Set()) {
  const { width, height, inner } = chart(plan, sched, hidden, null);
  return {
    width, height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
      + `<style>${css}</style><rect width="${width}" height="${height}" fill="#fff"/>${inner}</svg>`,
  };
}
