// Critical-path scheduler.
//
// Plan model:
//   { name, start: 'YYYY-MM-DD', holidays: [{date, label}], satOff, sunOff, tasks: [Task] }
//   satOff / sunOff: every Saturday / Sunday is non-working (default true)
//   nearCritical: tasks with 0 < float <= this many working days are marked
//     near-critical (default NEAR_DEFAULT; 0 turns it off)
//   Task = { id, name, level, duration, preds: [Link], manualStart: 'YYYY-MM-DD'|null,
//            pct, assignee, notes }
//   Link = { id, type: 'FS'|'SS'|'FF' } (a bare id is accepted as FS)
//
// Hierarchy is an outline: a task is a summary if the next row has a deeper
// level. Summary tasks roll up their children and do not take dependencies.
//
// Time model: a task with start index s and duration d occupies working days
// s .. s+d-1, so its finish *boundary* is s+d. A milestone (d = 0) is a point
// in time at boundary s, displayed as the end of working day s-1.
// Dependencies, for predecessor p and successor s:
//   FS  finish-to-start   s.es >= p.ef
//   SS  start-to-start    s.es >= p.es
//   FF  finish-to-finish  s.ef >= p.ef

import { Calendar, parseISO, toISO } from './calendar.js';

export const LINK_TYPES = ['FS', 'SS', 'FF'];

// A task's links in canonical form; tolerates bare ids (older plans).
export function linksOf(t) {
  return (t.preds || []).map(p => (typeof p === 'number' ? { id: p, type: 'FS' } : p))
    .filter(p => Number.isInteger(p.id) && LINK_TYPES.includes(p.type));
}

// Earliest start boundary that link `type` from predecessor p allows for a
// successor of duration d.
function earliestStart(p, type, d) {
  return type === 'SS' ? p.es : type === 'FF' ? p.ef - d : p.ef;
}

// Latest finish boundary for predecessor p that link `type` allows, given the
// successor's late start/finish.
function latestFinish(p, type, s) {
  return type === 'SS' ? s.ls + p.duration : type === 'FF' ? s.lf : s.ls;
}

// True when the link is what holds the successor where it is (zero slack on
// the link). Used to draw driving links on the critical path.
export function linkDrives(p, s, type) {
  return type === 'SS' ? p.es === s.es : type === 'FF' ? p.ef === s.ef : p.ef === s.es;
}

export function schedule(plan) {
  const cal = new Calendar(plan.start, plan.holidays, { satOff: plan.satOff !== false, sunOff: plan.sunOff !== false });
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
      pinned: false, es: 0, ef: 0, ls: null, lf: null, float: null, critical: false, near: false,
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
    for (const { id: pid, type } of linksOf(t)) {
      const p = res.get(pid);
      if (!p || pid === r.id) continue;
      if (p.summary) { r.issues.push(`Predecessor ${p.row} is a summary task (ignored)`); continue; }
      if (!r.preds.some(l => l.id === pid)) { r.preds.push({ id: pid, type }); p.succs.push({ id: r.id, type }); }
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
    for (const { id: sid } of r.succs) {
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
    for (const { id, type } of r.preds) earliest = Math.max(earliest, earliestStart(res.get(id), type, r.duration));
    if (r.pinned) {
      r.es = r.pinnedIdx;
      for (const { id, type } of r.preds) {
        const p = res.get(id);
        if (r.es < earliestStart(p, type, r.duration)) r.issues.push(CONFLICT[type](p.row));
      }
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
  const nearN = nearCriticalDays(plan);
  for (let k = order.length - 1; k >= 0; k--) {
    const r = order[k];
    let latest = projEndIdx;
    for (const { id, type } of r.succs) latest = Math.min(latest, latestFinish(r, type, res.get(id)));
    r.lf = latest;
    r.ls = r.lf - r.duration;
    r.float = r.ls - r.es;
    r.critical = r.float <= 0;
    r.near = !r.critical && r.float <= nearN;
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

// Ids of rows hidden under a collapsed summary. Each summary keeps its own
// `collapsed` flag, so expanding a parent restores nested groups as they were.
export function hiddenIds(plan, sched) {
  const hidden = new Set();
  let under = null; // level of the collapsed summary we are inside, if any
  sched.rows.forEach((r, i) => {
    if (under !== null && r.level > under) { hidden.add(r.id); return; }
    under = r.summary && plan.tasks[i].collapsed ? r.level : null;
  });
  return hidden;
}

// Near-critical threshold in working days (0 = off)
export const NEAR_DEFAULT = 2;
export function nearCriticalDays(plan) {
  const n = plan.nearCritical === undefined || plan.nearCritical === null ? NEAR_DEFAULT : Number(plan.nearCritical);
  return Number.isFinite(n) ? Math.max(0, Math.min(999, Math.round(n))) : NEAR_DEFAULT;
}

const CONFLICT = {
  FS: row => `Starts before predecessor ${row} finishes`,
  SS: row => `Starts before predecessor ${row} starts (SS)`,
  FF: row => `Finishes before predecessor ${row} finishes (FF)`,
};

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
