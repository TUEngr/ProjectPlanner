// Task table view. Renders one row per task with inline inputs; edits are
// committed by app.js when a field loses focus (or on Enter).

import { esc } from './gantt.js';
import { linksOf } from './schedule.js';

// w: default width (px), min: narrowest a user can drag it. Notes is the
// flexible column: it also takes any space left over when the table is
// narrower than the pane. The flag column has a fixed width.
export const COLUMNS = [
  { f: 'num', label: '#', cls: 'c-num', w: 44, min: 40 },
  { f: 'flag', label: '', cls: 'c-flag', w: 22, fixed: true },
  { f: 'name', label: 'Task name', cls: 'c-name', w: 260, min: 120 },
  { f: 'duration', label: 'Duration (days)', cls: 'c-dur', w: 104, min: 48 },
  { f: 'start', label: 'Start', cls: 'c-date', w: 150, min: 124 },
  { f: 'finish', label: 'Finish', cls: 'c-date', w: 150, min: 124 },
  { f: 'preds', label: 'Predecessors', cls: 'c-preds', w: 110, min: 60 },
  { f: 'pct', label: '% done', cls: 'c-pct', w: 70, min: 48 },
  { f: 'assignee', label: 'Assignee', cls: 'c-who', w: 120, min: 60 },
  { f: 'notes', label: 'Notes', cls: 'c-notes', w: 200, min: 80, flex: true },
  { f: 'float', label: 'Float', cls: 'c-float', w: 60, min: 44 },
];
export const COLUMN_MAX = 900;

// Effective widths: the user's (from prefs) clamped to each column's range
export function columnWidths(custom = {}) {
  const out = {};
  for (const c of COLUMNS) {
    const v = Number(custom[c.f]);
    out[c.f] = c.fixed || !Number.isFinite(v) ? c.w : Math.round(Math.min(COLUMN_MAX, Math.max(c.min, v)));
  }
  return out;
}

export function renderTableHead(thead) {
  thead.innerHTML = '<tr>' + COLUMNS.map(c => {
    const title = c.f === 'float' ? ' title="Working days this task can slip without delaying the project"' : '';
    const handle = c.fixed ? '' : `<span class="col-rs" data-col="${c.f}" data-tip="Drag to resize · double-click to reset" aria-hidden="true"></span>`;
    return `<th class="${c.cls}" data-col="${c.f}"${title}>${c.label}${handle}</th>`;
  }).join('') + '</tr>';
}

// Fixed table layout with one <col> per column. The table is at least as
// wide as the pane; the flexible (Notes) column absorbs any extra.
export function applyColumnWidths(table, widths) {
  let cg = table.querySelector('colgroup');
  if (!cg) {
    cg = document.createElement('colgroup');
    cg.innerHTML = COLUMNS.map(c => `<col data-col="${c.f}">`).join('');
    table.prepend(cg);
  }
  let sum = 0;
  for (const c of COLUMNS) {
    sum += widths[c.f];
    cg.querySelector(`col[data-col="${c.f}"]`).style.width = c.flex ? '' : `${widths[c.f]}px`;
  }
  table.style.width = `max(100%, ${sum}px)`;
}

export function renderTable(tbody, plan, sched, { selectedId = null, readOnly = false, hidden = new Set() } = {}) {
  const rowOf = new Map(sched.rows.map(r => [r.id, r.row]));
  const ro = readOnly ? ' readonly' : '';
  const html = sched.rows.map((r, i) => {
    if (hidden.has(r.id)) return '';
    const t = plan.tasks[i];
    const lockedRO = readOnly || r.summary ? ' readonly tabindex="-1"' : '';
    const predText = linksOf(t).filter(l => rowOf.has(l.id)).map(l => ({ row: rowOf.get(l.id), type: l.type }))
      .sort((a, b) => a.row - b.row).map(formatLink).join(', ');
    const cls = [r.summary && 'summary', !r.summary && r.critical && 'critical', r.milestone && 'milestone',
      r.id === selectedId && 'selected', r.issues.length && 'has-issue'].filter(Boolean).join(' ');
    const flag = r.issues.length
      ? `<span class="flag" tabindex="0" data-tip="${esc(r.issues.join('\n'))}" aria-label="Warning: ${esc(r.issues.join('; '))}">⚠</span>`
      : r.milestone ? '<span class="flag ms" tabindex="0" data-tip="Milestone (zero duration)" aria-label="Milestone">◆</span>' : '';
    const unpin = r.pinned && !readOnly
      ? `<button class="unpin" data-act="unpin" data-tip="Pinned start date. Click to unpin and schedule from predecessors." aria-label="Unpin start date">📌</button>`
      : r.pinned ? '<span class="unpin" tabindex="0" data-tip="Pinned start date" aria-label="Pinned start date">📌</span>' : '';
    const twisty = r.summary
      ? `<button class="twisty" data-act="toggle" style="left:${4 + r.level * 18}px" tabindex="-1" aria-expanded="${!t.collapsed}" title="${t.collapsed ? 'Expand' : 'Collapse'} (or double-click the row)">${t.collapsed ? '▸' : '▾'}</button>`
      : '';
    const input = (f, value, extra = '') =>
      `<input data-f="${f}" value="${esc(value)}" data-orig="${esc(value)}"${extra}>`;
    return `<tr data-id="${r.id}" class="${cls}">
      <td class="c-num">${r.row}</td>
      <td class="c-flag">${flag}</td>
      <td class="c-name">${twisty}${input('name', t.name, `${ro} placeholder="Task name" style="padding-left:${22 + r.level * 18}px" aria-label="Task name, row ${r.row}"`)}</td>
      <td class="c-dur">${input('duration', String(r.duration), `${lockedRO} inputmode="numeric" aria-label="Duration in working days"`)}</td>
      <td class="c-date${r.pinned ? ' pinned' : ''}">${input('start', r.start, `${lockedRO} type="date" aria-label="Start date"`)}${unpin}</td>
      <td class="c-date">${input('finish', r.finish, `${lockedRO} type="date" aria-label="Finish date"`)}</td>
      <td class="c-preds">${input('preds', predText, `${lockedRO} placeholder="${r.summary || readOnly ? '' : 'e.g. 2, 3SS, 4FF'}" title="Row numbers, optionally with a link type: 3 or 3FS (finish-to-start), 3SS (start-to-start), 3FF (finish-to-finish)" aria-label="Predecessors: row numbers with optional SS or FF"`)}</td>
      <td class="c-pct">${input('pct', String(r.pct), `${lockedRO} inputmode="numeric" aria-label="Percent complete"`)}</td>
      <td class="c-who">${input('assignee', t.assignee, `${ro} aria-label="Assignee"`)}</td>
      <td class="c-notes">${input('notes', t.notes, `${ro} aria-label="Notes"`)}</td>
      <td class="c-float">${r.summary || r.float === null ? '' : r.float}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = html || `<tr><td colspan="${COLUMNS.length}" class="empty">No tasks yet.</td></tr>`;
}

// Parse "5", "5d", "2w", "3 days". Returns working days or null.
export function parseDuration(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(d|days?|w|wks?|weeks?)?\s*$/i.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2] && /^w/i.test(m[2]) ? 5 : 1);
  return Math.round(n);
}

// FS is the default and is shown as a bare row number.
export function formatLink({ row, type }) {
  return type === 'FS' ? String(row) : `${row}${type}`;
}

// Parse "2, 3SS 5ff, 6 FS" into [{ row, type }]. Returns null if malformed.
// A row listed twice keeps its first link type.
export function parsePredList(s) {
  const out = [];
  const rest = s.replace(/(\d+)\s*(fs|ss|ff)?(?![a-z])/gi, (_, n, t) => {
    const row = Number(n);
    if (!out.some(l => l.row === row)) out.push({ row, type: (t || 'FS').toUpperCase() });
    return ' ';
  });
  return /^[\s,;]*$/.test(rest) ? out : null;
}
