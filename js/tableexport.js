// The task table for Print (an HTML table, so long plans flow across pages
// with the header repeated) and for PNG export (an SVG drawing of the same
// table). Both follow the screen: rows inside collapsed groups are left out,
// critical tasks are red, summaries bold, milestones marked ◆.

import { linksOf } from './schedule.js';
import { formatLink } from './table.js';
import { esc } from './gantt.js';

// [key, heading, width (px, for the image), right-aligned]
const COLS = [
  ['row', '#', 34, true], ['name', 'Task name', 290, false], ['duration', 'Duration', 74, true],
  ['start', 'Start', 86, false], ['finish', 'Finish', 86, false], ['preds', 'Predecessors', 100, false],
  ['pct', '% done', 56, true], ['assignee', 'Assignee', 110, false], ['notes', 'Notes', 230, false],
  ['float', 'Float', 48, true],
];
const ROW_H = 22, HEAD_H = 26, PAD = 6, CHAR_W = 6.6, INDENT = 14;

function fmt(n) {
  return new Date(n * 86400000).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
}

// One record per visible row: cell text plus row flags
function rowsFor(plan, sched, hidden) {
  const rowOf = new Map(sched.rows.map(r => [r.id, r.row]));
  return sched.rows.map((r, i) => ({ r, t: plan.tasks[i] })).filter(({ r }) => !hidden.has(r.id)).map(({ r, t }) => ({
    level: r.level,
    summary: r.summary, milestone: r.milestone, critical: !r.summary && r.critical, warn: r.issues.length > 0,
    cells: {
      row: String(r.row),
      name: `${r.milestone ? '◆ ' : ''}${t.name || '(unnamed)'}${r.summary && t.collapsed ? ' ▸' : ''}`,
      duration: String(r.duration),
      start: fmt(r.startDay), finish: fmt(r.finishDay),
      preds: linksOf(t).filter(l => rowOf.has(l.id)).map(l => ({ row: rowOf.get(l.id), type: l.type }))
        .sort((a, b) => a.row - b.row).map(formatLink).join(', '),
      pct: String(r.pct), assignee: t.assignee || '', notes: t.notes || '',
      float: r.summary || r.float === null ? '' : String(r.float),
    },
  }));
}

export function tablePrintHTML(plan, sched, hidden = new Set()) {
  const rows = rowsFor(plan, sched, hidden);
  const head = COLS.map(([k, h, , right]) => `<th class="tp-${k}${right ? ' num' : ''}">${h}</th>`).join('');
  const body = rows.map(x => `<tr class="${[x.summary && 'summary', x.critical && 'critical'].filter(Boolean).join(' ')}">`
    + COLS.map(([k, , , right]) => {
      const pad = k === 'name' ? ` style="padding-left:${4 + x.level * INDENT}px"` : '';
      const warn = k === 'name' && x.warn ? '⚠ ' : '';
      return `<td class="tp-${k}${right ? ' num' : ''}"${pad}>${warn}${esc(x.cells[k])}</td>`;
    }).join('') + '</tr>').join('');
  return `<table class="print-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function clip(s, px) {
  const n = Math.max(1, Math.floor(px / CHAR_W));
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
}

export function tableStandaloneSVG(plan, sched, css, hidden = new Set()) {
  const rows = rowsFor(plan, sched, hidden);
  const width = COLS.reduce((a, c) => a + c[2], 0);
  const height = HEAD_H + rows.length * ROW_H + 1;
  const xs = [];
  COLS.reduce((x, c) => { xs.push(x); return x + c[2]; }, 0);
  const text = (k, i, s, cls, y, indent = 0) => {
    const [, , w, right] = COLS[i];
    const x = right ? xs[i] + w - PAD : xs[i] + PAD + indent;
    return `<text class="${cls}" x="${x}" y="${y}"${right ? ' text-anchor="end"' : ''}>${esc(clip(s, w - 2 * PAD - indent))}</text>`;
  };
  const out = [`<rect class="tx-head-bg" width="${width}" height="${HEAD_H}"/>`];
  COLS.forEach(([k, h], i) => out.push(text(k, i, h, 'tx-head', 17)));
  rows.forEach((x, j) => {
    const y = HEAD_H + j * ROW_H;
    if (j % 2) out.push(`<rect class="tx-odd" y="${y}" width="${width}" height="${ROW_H}"/>`);
    const cls = ['tx-cell', x.summary && 'summary', x.critical && 'critical'].filter(Boolean).join(' ');
    COLS.forEach(([k], i) => {
      const s = (k === 'name' && x.warn ? '⚠ ' : '') + x.cells[k];
      out.push(text(k, i, s, k === 'row' || k === 'float' && !x.critical ? `${cls} muted` : cls, y + 15, k === 'name' ? x.level * INDENT : 0));
    });
    out.push(`<line class="tx-rule" x1="0" y1="${y + ROW_H}" x2="${width}" y2="${y + ROW_H}"/>`);
  });
  out.push(`<line class="tx-rule strong" x1="0" y1="${HEAD_H}" x2="${width}" y2="${HEAD_H}"/>`);
  return {
    width, height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
      + `<style>${css}</style><rect width="${width}" height="${height}" fill="#fff"/>${out.join('')}</svg>`,
  };
}
