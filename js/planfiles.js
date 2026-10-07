// Repo storage format: one plan file plus one file per task, so two people who
// edit different tasks touch different files and git merges them cleanly.
//
//   data/plan.json            settings: name, start date, holidays, views
//   data/tasks/<id>.json      one task each; order comes from `rank`
//
// Files are written deterministically (fixed key order, 2-space indent, final
// newline) so an unchanged plan always produces byte-identical files. Per-user
// view state (`collapsed`) and timestamps (`updated`) are deliberately not
// stored: they would create diffs and conflicts that carry no project meaning.

import { normalize, FORMAT_VERSION, TASK_ID_RE, RANK_RE } from './storage.js';

export const PLAN_FILE = 'data/plan.json';
export const TASK_DIR = 'data/tasks/';
const TASK_FILE_RE = /^data\/tasks\/([a-z0-9]{1,32})\.json$/;

// ---- Ranks: lexicographically ordered strings, so a task can be inserted
// between two others by changing only its own file. ----

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const isRank = r => typeof r === 'string' && RANK_RE.test(r);

// A rank strictly between a and b ('' = before everything, null = after everything).
export function rankBetween(a = '', b = null) {
  if (b !== null && a >= b) throw new Error(`rankBetween: ${a} must sort before ${b}`);
  if (b !== null) {
    let n = 0; // skip the common prefix, treating a missing digit of a as 0
    while ((a[n] || '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + rankBetween(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : BASE;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + rankBetween(a.slice(1), null);
}

// Evenly spaced starting ranks for n tasks, with room left to insert between.
function initialRanks(n) {
  let width = 1;
  while (BASE ** width < 4 * (n + 1)) width++;
  return Array.from({ length: n }, (_, i) => {
    let r = Math.floor(((i + 1) * BASE ** width) / (n + 1)).toString(BASE).padStart(width, '0');
    if (r.endsWith('0')) r += 'i';
    return r;
  });
}

// Indices of a longest strictly increasing run of valid ranks. Tasks outside it
// are the ones that moved (or are new), so only they get new ranks.
function stableIndices(tasks) {
  const tails = [], prev = new Array(tasks.length).fill(-1);
  tasks.forEach((t, i) => {
    if (!isRank(t.rank)) return;
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tasks[tails[mid]].rank < t.rank) lo = mid + 1; else hi = mid;
    }
    prev[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const keep = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

// Make task ranks strictly increasing in array order, changing as few as possible.
// Mutates the tasks; returns how many ranks changed.
export function assignRanks(tasks) {
  const keep = stableIndices(tasks);
  let changed = 0;
  if (!keep.size) {
    const ranks = initialRanks(tasks.length);
    tasks.forEach((t, i) => { if (t.rank !== ranks[i]) { t.rank = ranks[i]; changed++; } });
    return changed;
  }
  let lo = '';
  for (let i = 0; i < tasks.length; i++) {
    if (keep.has(i)) { lo = tasks[i].rank; continue; }
    let j = i + 1;
    while (j < tasks.length && !keep.has(j)) j++;
    tasks[i].rank = rankBetween(lo, j < tasks.length ? tasks[j].rank : null);
    lo = tasks[i].rank;
    changed++;
  }
  return changed;
}

// ---- Serialization ----

function json(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

function planObject(plan) {
  return {
    format: FORMAT_VERSION,
    id: plan.id,
    name: plan.name,
    start: plan.start,
    satOff: plan.satOff !== false, // same defaults as normalize(), so an
    sunOff: plan.sunOff !== false, // un-normalized plan saves identically
    showGantt: plan.showGantt !== false,
    showPert: plan.showPert !== false,
    holidays: [...(plan.holidays || [])]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
      .map(h => ({ date: h.date, label: h.label })),
  };
}

function taskObject(t) {
  return {
    id: t.id,
    rank: t.rank,
    name: t.name,
    level: t.level,
    duration: t.duration,
    preds: t.preds.map(l => ({ id: l.id, type: l.type })),
    manualStart: t.manualStart,
    pct: t.pct,
    assignee: t.assignee,
    notes: t.notes,
  };
}

// plan -> { path: text }. Fills in missing or out-of-order ranks on the plan's
// tasks first, so what is saved and what is in memory agree.
export function planToFiles(plan) {
  assignRanks(plan.tasks);
  const files = { [PLAN_FILE]: json(planObject(plan)) };
  for (const t of plan.tasks) files[`${TASK_DIR}${t.id}.json`] = json(taskObject(t));
  return files;
}

function parseFile(path, text) {
  try {
    return JSON.parse(text);
  } catch {
    const why = /^(<{7}|={7}|>{7})/m.test(text) ? ' It contains unresolved merge-conflict markers.' : '';
    throw new Error(`${path} is not valid JSON.${why}`);
  }
}

// { path: text } -> plan. Unrelated paths are ignored; a file name is its task's id.
export function planFromFiles(files) {
  if (typeof files[PLAN_FILE] !== 'string') throw new Error(`${PLAN_FILE} is missing.`);
  const base = parseFile(PLAN_FILE, files[PLAN_FILE]);
  const tasks = [];
  for (const [path, text] of Object.entries(files)) {
    const m = TASK_FILE_RE.exec(path);
    if (!m || !TASK_ID_RE.test(m[1])) continue;
    const t = parseFile(path, text);
    if (!t || typeof t !== 'object') throw new Error(`${path} is not a task.`);
    tasks.push({ ...t, id: m[1] });
  }
  const order = (a, b) => (isRank(a.rank) !== isRank(b.rank) ? (isRank(a.rank) ? -1 : 1)
    : a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  tasks.sort(order);
  const plan = normalize({ ...base, tasks });
  // A merge can leave a link to a task someone else deleted; drop it.
  const ids = new Set(plan.tasks.map(t => t.id));
  for (const t of plan.tasks) t.preds = t.preds.filter(l => ids.has(l.id));
  return plan;
}

// ---- Comparing and merging file sets ----

export function sameFiles(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k]);
}

// Three-way merge of two file sets that both started from `base`.
// A file changed (or added, or deleted) on one side only takes that side's
// version. A file changed on both sides differently is a conflict: it is
// listed, and resolved by `prefer` ('mine' | 'theirs') or, with none, kept as mine.
export function mergeFiles(base, mine, theirs, prefer = null) {
  const files = {}, conflicts = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const b = base[path], m = mine[path], t = theirs[path];
    let v;
    if (m === t) v = m;
    else if (m === b) v = t;
    else if (t === b) v = m;
    else {
      conflicts.push(path);
      v = prefer === 'theirs' ? t : m;
    }
    if (v !== undefined) files[path] = v;
  }
  if (files[PLAN_FILE] === undefined) files[PLAN_FILE] = mine[PLAN_FILE] ?? theirs[PLAN_FILE] ?? base[PLAN_FILE];
  return { files, conflicts: conflicts.sort() };
}
