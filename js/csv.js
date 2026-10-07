// CSV export of the task table for spreadsheets (Excel, Google Sheets).
// One row per task in plan order, including tasks inside collapsed groups.
// RFC 4180 quoting, CRLF line ends, and a UTF-8 byte-order mark so Excel
// reads non-ASCII names correctly.

import { linksOf } from './schedule.js';
import { formatLink } from './table.js';
import { parseISO } from './calendar.js';

const HEADER = ['WBS', 'Row', 'Outline level', 'Task', 'Type', 'Duration (working days)', 'Start', 'Finish',
  'Predecessors', '% complete', 'Assignee', 'Notes', 'Float (working days)', 'Critical', 'Pinned start'];

function cell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function planToCSV(plan, sched) {
  const rowOf = new Map(sched.rows.map(r => [r.id, r.row]));
  const counters = [];
  const lines = [HEADER];
  sched.rows.forEach((r, i) => {
    const t = plan.tasks[i];
    counters.length = r.level + 1;
    counters[r.level] = (counters[r.level] || 0) + 1;
    const wbs = counters.map(n => n || 1).join('.');
    const preds = linksOf(t).filter(l => rowOf.has(l.id)).map(l => ({ row: rowOf.get(l.id), type: l.type }))
      .sort((a, b) => a.row - b.row).map(formatLink).join(', ');
    lines.push([
      wbs, r.row, r.level + 1, t.name,
      r.summary ? 'Summary' : r.milestone ? 'Milestone' : 'Task',
      r.duration, r.start, r.finish, preds, r.pct, t.assignee, t.notes,
      r.summary || r.float === null ? '' : r.float,
      r.summary ? '' : r.critical ? 'Yes' : 'No',
      r.pinned ? r.start : '',
    ]);
  });
  return '\uFEFF' + lines.map(l => l.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ---- Import ----

// Dates in a CSV: ISO, or US month/day/year (Excel rewrites ISO dates that
// way when it re-saves a file). Returns 'YYYY-MM-DD' or null.
export function csvDate(s) {
  if (parseISO(s) !== null) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const iso = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return parseISO(iso) === null ? null : iso;
}

// RFC 4180 parse: quoted fields may contain the delimiter, quotes ("") and
// line breaks. Accepts CRLF or LF and a leading byte-order mark. The
// delimiter is ',' unless the header line has more ';' or tabs (Excel in
// some locales writes ';').
export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.slice(0, text.search(/\r?\n|$/));
  const count = ch => first.split(ch).length - 1;
  const delim = [',', ';', '\t'].reduce((a, b) => (count(b) > count(a) ? b : a));
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

// Header names accepted for each field (compared lower-case, punctuation-free)
const ALIASES = {
  name: ['task', 'name', 'task name', 'title'],
  row: ['row', '#', 'id', 'row number'],
  level: ['outline level', 'level', 'indent'],
  wbs: ['wbs', 'outline', 'outline number'],
  type: ['type'],
  duration: ['duration', 'duration working days', 'duration days', 'days'],
  preds: ['predecessors', 'predecessor', 'depends on', 'dependencies'],
  pct: ['% complete', 'percent complete', 'complete', '% done', 'pct'],
  assignee: ['assignee', 'assigned to', 'resource', 'resources', 'owner'],
  notes: ['notes', 'note', 'comments'],
  pinned: ['pinned start', 'manual start', 'start no earlier than', 'fixed start'],
  start: ['start'],
};
const key = s => s.toLowerCase().replace(/[^a-z0-9%# ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Columns found in a header row: { field: index }
function headerColumns(row) {
  const head = row.map(c => key(String(c ?? '')));
  const col = {};
  for (const [f, names] of Object.entries(ALIASES)) {
    const k = head.findIndex(h => names.includes(h));
    if (k >= 0) col[f] = k;
  }
  return col;
}

// Index of the header row: the first row (of the first 20) with a Task/Name
// column, so title rows above the table are skipped. -1 if none.
export function findHeaderRow(rows) {
  return rows.slice(0, 20).findIndex(r => headerColumns(r).name !== undefined);
}

// Turn CSV text into a plan object (to be passed through storage.normalize).
// parsePreds parses "2, 5SS" into [{row, type}] (table.js parsePredList).
// Returns { plan, warnings }; throws with a readable message if unusable.
export function csvToPlan(text, opts) {
  return rowsToPlan(parseCSV(text), { ...opts, what: 'CSV file' });
}

// Same, from rows already split into cells (a CSV file, or a spreadsheet).
export function rowsToPlan(allRows, { name = 'Imported plan', parsePreds, isoDate, what = 'file' }) {
  const rows = allRows.filter(r => r.some(f => String(f ?? '').trim() !== ''));
  const h = findHeaderRow(rows);
  if (h < 0) throw new Error(`The ${what} needs a “Task” (or “Name”) column, with column names in a header row.`);
  const col = headerColumns(rows[h]);
  if (rows.length - h < 2) throw new Error(`The ${what} needs a header row and at least one task.`);
  const get = (r, f) => (col[f] === undefined ? '' : String(r[col[f]] ?? '').trim());
  const warnings = [];
  const body = rows.slice(h + 1);

  // Row numbers used by the Predecessors column: the Row column if present
  // and usable, otherwise the line order
  const rowNums = body.map((r, i) => Number(get(r, 'row')) || i + 1);
  const byRow = new Map();
  rowNums.forEach((n, i) => { if (!byRow.has(n)) byRow.set(n, i + 1); });

  let badLinks = 0, badNums = 0;
  const num = (v, dflt) => {
    if (v === '') return dflt;
    const x = Number(v.replace('%', ''));
    if (Number.isFinite(x)) return x;
    badNums++;
    return dflt;
  };
  const tasks = body.map((r, i) => {
    const wbs = get(r, 'wbs');
    const level = col.level !== undefined && get(r, 'level') !== ''
      ? Math.max(0, num(get(r, 'level'), 1) - 1)
      : /^\d+(\.\d+)*$/.test(wbs) ? wbs.split('.').length - 1 : 0;
    const type = get(r, 'type').toLowerCase();
    const links = parsePreds(get(r, 'preds')) ?? (badLinks++, []);
    const preds = [];
    for (const l of links) {
      const id = byRow.get(l.row);
      if (id && id !== i + 1) preds.push({ id, type: l.type }); else badLinks++;
    }
    const pinned = isoDate(get(r, 'pinned'));
    return {
      id: i + 1,
      name: get(r, 'name'),
      level,
      // A summary's duration and % are roll-ups of its subtasks (as in our
      // own export), not data to keep
      duration: type === 'milestone' || type === 'summary' ? 0 : Math.max(0, Math.round(num(get(r, 'duration'), 1))),
      preds,
      manualStart: pinned,
      pct: type === 'summary' ? 0 : num(get(r, 'pct'), 0),
      assignee: get(r, 'assignee'),
      notes: get(r, 'notes'),
    };
  });
  if (badLinks) warnings.push(`${badLinks} predecessor reference${badLinks > 1 ? 's' : ''} could not be matched and were dropped`);
  if (badNums) warnings.push(`${badNums} non-numeric duration or % value${badNums > 1 ? 's' : ''} replaced with defaults`);

  // Project start: the earliest Start date in the file, if it has any
  const starts = body.map(r => isoDate(get(r, 'start'))).filter(Boolean).sort();
  return {
    plan: { name, start: starts[0], holidays: [], tasks, nextId: tasks.length + 1 },
    warnings,
  };
}

// Starter table in the layout the importer reads, with rows showing each
// feature. Offered as CSV and Excel templates when an import fails.
export const TEMPLATE_ROWS = [
  ['Row', 'Outline level', 'Task', 'Type', 'Duration (working days)', 'Predecessors', '% complete', 'Assignee', 'Notes', 'Pinned start'],
  [1, 1, 'Phase 1', 'Summary', '', '', '', '', 'A summary groups the rows below it with a higher outline level; its dates are calculated', ''],
  [2, 2, 'Design', 'Task', 5, '', 0, 'Alex', 'Duration is in working days', ''],
  [3, 2, 'Build', 'Task', 10, '2', 0, 'Sam', 'Predecessors are row numbers: 2 = starts after row 2 finishes', ''],
  [4, 2, 'Write test plan', 'Task', 3, '3SS', 0, 'Jordan', '3SS = starts no earlier than row 3 starts; 3FF = finishes no earlier than row 3 finishes', ''],
  [5, 1, 'Design review', 'Milestone', 0, '3, 4', 0, 'Advisor', 'Duration 0 is a milestone. Several predecessors are separated by commas', ''],
  [6, 1, 'Final demo', 'Task', 1, '5', 0, 'Team', 'Pinned start (YYYY-MM-DD) fixes the start date; leave it blank to schedule from predecessors', ''],
];

export function csvTemplate() {
  return '\uFEFF' + TEMPLATE_ROWS.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
