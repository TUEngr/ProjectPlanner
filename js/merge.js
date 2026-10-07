// Field-level three-way merge of one data file (a task or the plan settings).
//
// Git merges by line, so two people changing different fields of the same task
// can still conflict (the fields sit on neighbouring lines). This merges by
// field instead: a field changed on one side only is taken from that side; a
// field changed on both sides to different values is a real conflict the user
// must settle. Lists keyed by an id (a task's predecessors, the plan's
// holidays) merge entry by entry, so adding different entries never conflicts.
//
// "ours" is the local side, "theirs" is the remote side.

import { PLAN_FILE, TASK_DIR, serializeFile } from './planfiles.js';

export const LABELS = {
  rank: 'Position in the list', name: 'Name', level: 'Indent level', duration: 'Duration (days)',
  manualStart: 'Pinned start date', pct: '% complete', assignee: 'Assignee', notes: 'Notes',
  preds: 'Predecessor', start: 'Project start', satOff: 'Saturdays off', sunOff: 'Sundays off',
  showGantt: 'Gantt view', showPert: 'PERT view', nearCritical: 'Near-critical threshold (days)', holidays: 'Holiday',
};
const SCALARS = {
  task: ['rank', 'name', 'level', 'duration', 'manualStart', 'pct', 'assignee', 'notes'],
  plan: ['name', 'start', 'satOff', 'sunOff', 'showGantt', 'showPert', 'nearCritical'],
};
const KEYED = { task: { preds: 'id' }, plan: { holidays: 'date' } };

// Equality that ignores object key order.
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
const same = (a, b) => canon(a) === canon(b);

// null = absent, false = not a JSON object
function parse(text) {
  if (text === null || text === undefined) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : false;
  } catch { return false; }
}

// Which side's value to keep given base, ours, theirs; or a conflict.
function pick(b, o, t) {
  if (same(o, t)) return { v: o, how: 'same' };
  if (same(o, b)) return { v: t, how: 'theirs' };
  if (same(t, b)) return { v: o, how: 'ours' };
  return { conflict: true };
}

// analysis = { path, title, kind: 'fields' | 'raw', conflicts, auto, build(choices) }
//   conflicts: [{ id, field, key?, label, ours, theirs }]; a deleted side is null/undefined
//   auto: how many changes were merged without asking
//   build(choices): the merged object (or null = delete the file); choices maps a
//                   conflict id to 'ours' | 'theirs' (unchosen counts as ours)
export function analyze(path, { base, ours, theirs }) {
  const b = parse(base), o = parse(ours), t = parse(theirs);
  const named = x => (x && typeof x === 'object' && typeof x.name === 'string' && x.name ? x.name : null);
  const title = path === PLAN_FILE ? 'Plan settings' : named(o) || named(t) || named(b) || path.slice(TASK_DIR.length).replace(/\.json$/, '');
  if (b === false || o === false || t === false) return { path, title, kind: 'raw', conflicts: [], auto: 0, build: () => null };

  if (o === null || t === null) { // deleted on at least one side
    if (o === null && t === null) return { path, title, kind: 'fields', conflicts: [], auto: 0, build: () => null };
    const kept = o ?? t;
    if (b && same(kept, b)) return { path, title, kind: 'fields', conflicts: [], auto: 1, build: () => null }; // they only deleted it
    return {
      path, title, kind: 'fields', auto: 0,
      conflicts: [{ id: '*', field: '*', label: 'Task', ours: o, theirs: t }],
      build: choices => (choices['*'] === 'theirs' ? t : o),
    };
  }

  const kind = path === PLAN_FILE ? 'plan' : 'task';
  const bb = b || {};
  const merged = {}, conflicts = [], lists = [];
  let auto = 0;

  for (const field of SCALARS[kind]) {
    const r = pick(bb[field], o[field], t[field]);
    if (r.conflict) {
      conflicts.push({ id: field, field, label: LABELS[field], ours: o[field], theirs: t[field] });
      merged[field] = o[field];
    } else {
      if (r.how !== 'same') auto++;
      merged[field] = r.v;
    }
  }
  if (kind === 'plan') {
    // Not a user-visible choice: the plan's id is only a cache key. Pick the same one on both sides.
    merged.id = [o.id, t.id].filter(x => typeof x === 'string').sort()[0];
    merged.format = Math.max(o.format || 0, t.format || 0);
  } else {
    merged.id = o.id ?? t.id;
  }

  for (const [field, keyName] of Object.entries(KEYED[kind])) {
    const lb = bb[field] || [], lo = o[field] || [], lt = t[field] || [];
    const by = list => new Map(list.map(x => [x[keyName], x]));
    const mb = by(lb), mo = by(lo), mt = by(lt);
    const keys = [...new Set([...lo, ...lt, ...lb].map(x => x[keyName]))]; // mine first, then theirs, in their own order
    const entries = [];
    for (const key of keys) {
      const r = pick(mb.get(key), mo.get(key), mt.get(key));
      if (r.conflict) {
        const id = `${field}:${key}`;
        conflicts.push({ id, field, key, label: LABELS[field], ours: mo.get(key), theirs: mt.get(key) });
        entries.push({ key, value: mo.get(key), id });
      } else {
        if (r.how !== 'same') auto++;
        entries.push({ key, value: r.v });
      }
    }
    lists.push({ field, entries, theirs: mt });
  }

  const build = choices => {
    const obj = { ...merged };
    for (const c of conflicts) {
      if (c.key === undefined && choices[c.id] === 'theirs') obj[c.field] = c.theirs;
    }
    for (const { field, entries, theirs: mt } of lists) {
      obj[field] = entries
        .map(e => (e.id && choices[e.id] === 'theirs' ? mt.get(e.key) : e.value))
        .filter(v => v !== undefined);
    }
    return obj;
  };
  return { path, title, kind: 'fields', conflicts, auto, build };
}

// The text to write for this file, or null to delete it.
export function finish(analysis, choices = {}) {
  const obj = analysis.build(choices);
  return obj === null ? null : serializeFile(analysis.path, obj);
}
