// Critical-path scheduler.
//
// Plan model:
//   { name, start: 'YYYY-MM-DD', holidays: [{date, label}], tasks: [Task] }
//   Task = { id, name, level, duration, preds: [id], manualStart: 'YYYY-MM-DD'|null,
//            pct, assignee, notes }
//
// Hierarchy is an outline: a task is a summary if the next row has a deeper
// level. Summary tasks roll up their children and do not take dependencies.
//
// Time model: a task with start index s and duration d occupies working days
// s .. s+d-1, so its finish *boundary* is s+d. A milestone (d = 0) is a point
// in time at boundary s, displayed as the end of working day s-1.
// Dependencies are finish-to-start: successor.es >= predecessor.ef.

import { Calendar, parseISO, toISO } from './calendar.js';

export function schedule(plan) {
  const cal = new Calendar(plan.start, plan.holidays);
  const tasks = plan.tasks;
  const n = tasks.length;
  const res = new Map(); // id -> result
  const rows = [];

  // Outline structure
  const stack = [];
  tasks.forEach((t, i) => {
    const level = Math.max(0, t.level | 0);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const r = {
      id: t.id, row: i + 1, level,
      summary: i + 1 < n && (tasks[i + 1].level | 0) > level,
      parent: stack.length ? stack[stack.length - 1].id : null,
      children: [], issues: [],
      duration: Math.max(0, Math.round(Number(t.duration) || 0)),
      pinned: false, es: 0, ef: 0, ls: null, lf: null, float: null, critical: false,
      preds: [], succs: [], pct: clampPct(t.pct),
    };
    if (r.parent !== null) res.get(r.parent).children.push(t.id);
    res.set(t.id, r);
    rows.push(r);
    stack.push(r);
  });

  const leaves = rows.filter(r => !r.summary);

  // Validate dependencies
  for (const r of leaves) {
    const t = tasks[r.row - 1];
    for (const pid of t.preds || []) {
      const p = res.get(pid);
      if (!p || pid === r.id) continue;
      if (p.summary) { r.issues.push(`Predecessor ${p.row} is a summary task (ignored)`); continue; }
      if (!r.preds.includes(pid)) { r.preds.push(pid); p.succs.push(r.id); }
    }
    if (t.manualStart) {
      const d = parseISO(t.manualStart);
      if (d === null) r.issues.push('Invalid manual start date');
      else { r.pinned = true; r.pinnedIdx = cal.index(d) + (r.duration === 0 ? 1 : 0); }
    }
  }

  // Topological order (Kahn). Tasks left over are in a cycle.
  const indeg = new Map(leaves.map(r => [r.id, r.preds.length]));
  const order = [];
  const queue = leaves.filter(r => r.preds.length === 0);
  while (queue.length) {
    const r = queue.shift();
    order.push(r);
    for (const sid of r.succs) {
      indeg.set(sid, indeg.get(sid) - 1);
      if (indeg.get(sid) === 0) queue.push(res.get(sid));
    }
  }
  const inOrder = new Set(order.map(r => r.id));
  const cyclic = leaves.filter(r => !inOrder.has(r.id));
  for (const r of cyclic) r.issues.push('Circular dependency');

  // Forward pass
  for (const r of order) {
    let earliest = 0;
    for (const pid of r.preds) earliest = Math.max(earliest, res.get(pid).ef);
    if (r.pinned) {
      r.es = r.pinnedIdx;
      if (r.preds.length && r.es < earliest) r.issues.push('Starts before a predecessor finishes');
    } else {
      r.es = earliest;
    }
    r.ef = r.es + r.duration;
  }
  for (const r of cyclic) { // schedule ignoring dependencies so they still display
    r.es = r.pinned ? r.pinnedIdx : 0;
    r.ef = r.es + r.duration;
  }

  const projStartIdx = Math.min(0, ...leaves.map(r => r.es));
  const projEndIdx = Math.max(0, ...leaves.map(r => r.ef));

  // Backward pass
  for (let k = order.length - 1; k >= 0; k--) {
    const r = order[k];
    let latest = projEndIdx;
    for (const sid of r.succs) latest = Math.min(latest, res.get(sid).ls);
    r.lf = latest;
    r.ls = r.lf - r.duration;
    r.float = r.ls - r.es;
    r.critical = r.float <= 0;
  }

  // Summary rollup, deepest first
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r.summary) continue;
    const kids = r.children.map(id => res.get(id));
    r.es = Math.min(...kids.map(c => c.es));
    r.ef = Math.max(...kids.map(c => c.ef));
    r.duration = r.ef - r.es;
    const weight = kids.reduce((s, c) => s + Math.max(c.duration, 1), 0);
    r.pct = Math.round(kids.reduce((s, c) => s + c.pct * Math.max(c.duration, 1), 0) / weight);
    if (tasks[i].preds?.length) r.issues.push('Summary tasks cannot have predecessors (ignored)');
  }

  // Calendar dates for display
  for (const r of rows) {
    r.milestone = !r.summary && r.duration === 0;
    if (r.milestone) {
      // A milestone sits at the end of the working day before boundary es,
      // except an unlinked milestone at the project start, which sits at its start.
      const atEnd = r.pinned || r.es > 0;
      r.startDay = r.finishDay = cal.day(atEnd ? r.es - 1 : r.es);
      r.pointDay = atEnd ? r.startDay + 1 : r.startDay; // calendar position for the chart
    } else {
      r.startDay = cal.day(r.es);
      r.finishDay = cal.day(Math.max(r.es, r.ef - 1));
    }
    r.start = toISO(r.startDay);
    r.finish = toISO(r.finishDay);
  }

  const startDay = Math.min(cal.day(0), ...rows.map(r => r.startDay));
  const finishDay = Math.max(cal.day(0), ...rows.map(r => r.finishDay));
  return {
    cal, rows, byId: res,
    start: toISO(startDay), finish: toISO(finishDay),
    startDay, finishDay,
    workdays: projEndIdx - projStartIdx,
  };
}

function clampPct(v) {
  const x = Math.round(Number(v) || 0);
  return Math.min(100, Math.max(0, x));
}

// Duration in working days for a task that starts and finishes on the given
// days (inclusive). Returns null if finish is before start.
export function durationBetween(cal, startDay, finishDay) {
  const a = cal.index(startDay);
  const b = cal.index(finishDay);
  const d = b - a + (cal.isWorkday(finishDay) ? 1 : 0);
  return d < 0 ? null : d;
}
