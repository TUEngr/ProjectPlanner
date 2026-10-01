// Application controller: state, editing commands, persistence, and views.

import { parseISO, toISO } from './calendar.js';
import { schedule, durationBetween } from './schedule.js';
import { renderGantt, ganttPrintSVG, scrollToDay, esc } from './gantt.js';
import { renderTable, renderTableHead, parseDuration, parseRowList } from './table.js';
import * as store from './storage.js';
import { samplePlan } from './sample.js';

const $ = sel => document.querySelector(sel);
const PREFS_KEY = 'projectplanner.prefs';

const state = {
  plan: null,
  sched: null,
  selectedId: null,
  readOnly: false,
  view: 'split',
  zoom: 'day',
  undo: [],
  redo: [],
};

// ---------- preferences (per browser) ----------

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (['table', 'gantt', 'split'].includes(p.view)) state.view = p.view;
    if (['day', 'week', 'month'].includes(p.zoom)) state.zoom = p.zoom;
  } catch { /* defaults */ }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ view: state.view, zoom: state.zoom })); } catch { /* ignore */ }
}

// ---------- toast ----------

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 5000 : 2500);
}

// ---------- plan lifecycle ----------

function openPlan(plan, { readOnly = false } = {}) {
  state.plan = plan;
  state.readOnly = readOnly;
  state.selectedId = plan.tasks[0]?.id ?? null;
  state.undo = [];
  state.redo = [];
  document.body.classList.toggle('readonly', readOnly);
  $('#readonly-banner').hidden = !readOnly;
  render({ scrollGantt: true });
}

function persist() {
  if (state.readOnly) return;
  if (!store.savePlan(state.plan)) toast('Could not save to browser storage. Use “Save file” to keep your work.', 'error');
}

// Wrap every edit: snapshot for undo, mutate, save, re-render.
function commit(mutator) {
  if (state.readOnly) return;
  const before = JSON.stringify(state.plan);
  const result = mutator(state.plan);
  if (result === false) return; // mutator rejected the change
  if (JSON.stringify(state.plan) === before) return;
  state.undo.push(before);
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
  persist();
  render();
}

function undo() {
  if (!state.undo.length) return toast('Nothing to undo');
  state.redo.push(JSON.stringify(state.plan));
  state.plan = JSON.parse(state.undo.pop());
  persist();
  render();
}
function redo() {
  if (!state.redo.length) return toast('Nothing to redo');
  state.undo.push(JSON.stringify(state.plan));
  state.plan = JSON.parse(state.redo.pop());
  persist();
  render();
}

// ---------- rendering ----------

function render({ scrollGantt = false } = {}) {
  const { plan } = state;
  try {
    state.sched = schedule(plan);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  if (!plan.tasks.some(t => t.id === state.selectedId)) state.selectedId = plan.tasks[0]?.id ?? null;

  // Remember focus so the table can be rebuilt under the cursor
  const active = document.activeElement;
  const focusRow = active?.closest?.('tr[data-id]')?.dataset.id;
  const focusField = active?.dataset?.f;

  $('#plan-name').textContent = plan.name;
  document.title = `${plan.name} – Project Planner`;
  $('#main').className = `view-${state.view}`;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === state.view));
  $('#zoom').value = state.zoom;

  renderTable($('#tbody'), plan, state.sched, { selectedId: state.selectedId, readOnly: state.readOnly });
  const pane = $('#gantt-pane');
  const { scrollLeft, scrollTop } = pane;
  renderGantt(pane, plan, state.sched, { zoom: state.zoom, selectedId: state.selectedId });
  if (scrollGantt) scrollToDay(pane, state.sched, state.zoom, state.sched.startDay);
  else { pane.scrollLeft = scrollLeft; pane.scrollTop = scrollTop; }

  if (focusRow && focusField) {
    const el = document.querySelector(`#tbody tr[data-id="${focusRow}"] input[data-f="${focusField}"]`);
    if (el) el.focus({ preventScroll: true });
  }
  renderStatus();
  updateUndoButtons();
}

function renderStatus() {
  const s = state.sched;
  const leaves = s.rows.filter(r => !r.summary);
  const crit = leaves.filter(r => r.critical).length;
  const issues = s.rows.filter(r => r.issues.length).length;
  const done = leaves.length
    ? Math.round(leaves.reduce((a, r) => a + r.pct * Math.max(r.duration, 1), 0) / leaves.reduce((a, r) => a + Math.max(r.duration, 1), 0))
    : 0;
  $('#status').innerHTML = [
    `<span><b>Start</b> ${fmtDate(s.start)}</span>`,
    `<span><b>Finish</b> ${fmtDate(s.finish)}</span>`,
    `<span><b>${s.workdays}</b> working days</span>`,
    `<span><b>${leaves.length}</b> tasks, <span class="crit-text">${crit} critical</span></span>`,
    `<span><b>${done}%</b> complete</span>`,
    issues ? `<span class="warn-text">⚠ ${issues} warning${issues > 1 ? 's' : ''}</span>` : '',
    `<span class="save-state">${state.readOnly ? 'Read-only' : 'Saved in this browser'}</span>`,
  ].join('');
}

function updateUndoButtons() {
  document.querySelector('[data-cmd="undo"]').disabled = !state.undo.length;
  document.querySelector('[data-cmd="redo"]').disabled = !state.redo.length;
}

function fmtDate(iso) {
  const n = parseISO(iso);
  return new Date(n * 86400000).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------- selection ----------

function select(id) {
  if (id === state.selectedId) return;
  state.selectedId = id;
  document.querySelectorAll('#tbody tr.selected').forEach(tr => tr.classList.remove('selected'));
  document.querySelector(`#tbody tr[data-id="${id}"]`)?.classList.add('selected');
  document.querySelectorAll('#gantt-pane .selected').forEach(el => el.classList.remove('selected'));
  document.querySelectorAll(`#gantt-pane .g-row-bg[data-id="${id}"], #gantt-pane .g-row[data-id="${id}"] .g-row-bg`)
    .forEach(el => el.classList.add('selected'));
}

// ---------- cell edits ----------

function applyEdit(id, field, raw) {
  const value = raw.trim();
  const idx = state.plan.tasks.findIndex(t => t.id === id);
  if (idx < 0) return;
  const row = state.sched.byId.get(id);

  commit(plan => {
    const t = plan.tasks[idx];
    switch (field) {
      case 'name': t.name = raw; break;
      case 'assignee': t.assignee = value; break;
      case 'notes': t.notes = raw; break;
      case 'duration': {
        const d = parseDuration(value);
        if (d === null) return reject('Duration must be a number of working days, e.g. 5, 5d, or 2w.');
        t.duration = d;
        break;
      }
      case 'pct': {
        const p = Number(value.replace('%', ''));
        if (!Number.isFinite(p)) return reject('% complete must be a number from 0 to 100.');
        t.pct = Math.max(0, Math.min(100, Math.round(p)));
        break;
      }
      case 'start': {
        if (!value) { t.manualStart = null; break; }
        if (parseISO(value) === null) return reject('Enter a valid start date.');
        t.manualStart = value;
        break;
      }
      case 'finish': {
        const f = parseISO(value);
        if (f === null) return reject('Enter a valid finish date.');
        const d = durationBetween(state.sched.cal, row.startDay, f);
        if (d === null) return reject('Finish date is before the start date.');
        t.duration = row.milestone && d === 1 && f === row.startDay ? 0 : d;
        break;
      }
      case 'preds': {
        const nums = parseRowList(value);
        if (nums === null) return reject('Predecessors must be row numbers separated by commas, e.g. 2, 5.');
        const ids = [];
        for (const n of nums) {
          const p = plan.tasks[n - 1];
          if (!p) return reject(`There is no row ${n}.`);
          if (p.id === id) return reject('A task cannot be its own predecessor.');
          ids.push(p.id);
        }
        t.preds = ids;
        break;
      }
      default: return false;
    }
  });
}

function reject(msg) {
  toast(msg, 'error');
  render(); // restore the cell's previous value
  return false;
}

// ---------- row commands ----------

// Index range [i, end) of a task and its outline descendants.
function subtreeEnd(tasks, i) {
  let end = i + 1;
  while (end < tasks.length && tasks[end].level > tasks[i].level) end++;
  return end;
}

function runCommand(cmd) {
  if (cmd === 'undo') return undo();
  if (cmd === 'redo') return redo();
  const tasks = state.plan.tasks;
  const i = tasks.findIndex(t => t.id === state.selectedId);

  switch (cmd) {
    case 'add':
    case 'insert': {
      let newId;
      commit(plan => {
        newId = plan.nextId++;
        const t = store.blankTask(newId);
        if (i < 0) { plan.tasks.push(t); return; }
        const sel = plan.tasks[i];
        if (cmd === 'insert') {
          t.level = sel.level;
          plan.tasks.splice(i, 0, t);
        } else {
          // After the selected task's subtree, at the same level; or as first child of a summary
          const isSummary = i + 1 < plan.tasks.length && plan.tasks[i + 1].level > sel.level;
          t.level = isSummary ? sel.level + 1 : sel.level;
          plan.tasks.splice(isSummary ? i + 1 : subtreeEnd(plan.tasks, i), 0, t);
        }
      });
      state.selectedId = newId;
      render();
      document.querySelector(`#tbody tr[data-id="${newId}"] input[data-f="name"]`)?.focus();
      break;
    }
    case 'delete': {
      if (i < 0) return;
      const name = tasks[i].name || `row ${i + 1}`;
      commit(plan => {
        const [gone] = plan.tasks.splice(i, 1);
        for (let k = i; k < plan.tasks.length && plan.tasks[k].level > gone.level; k++) plan.tasks[k].level--;
        for (const t of plan.tasks) t.preds = t.preds.filter(p => p !== gone.id);
        state.selectedId = plan.tasks[Math.min(i, plan.tasks.length - 1)]?.id ?? null;
      });
      toast(`Deleted “${name}”. Undo is available.`);
      break;
    }
    case 'indent':
    case 'outdent': {
      if (i < 0) return;
      const delta = cmd === 'indent' ? 1 : -1;
      if (delta > 0 && (i === 0 || tasks[i - 1].level < tasks[i].level)) return toast('Nothing above to indent under.');
      if (delta < 0 && tasks[i].level === 0) return;
      commit(plan => {
        const end = subtreeEnd(plan.tasks, i);
        for (let k = i; k < end; k++) plan.tasks[k].level += delta;
        store.fixLevels(plan.tasks);
      });
      break;
    }
    case 'up':
    case 'down': {
      if (i < 0) return;
      const j = cmd === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= tasks.length) return;
      commit(plan => {
        [plan.tasks[i], plan.tasks[j]] = [plan.tasks[j], plan.tasks[i]];
        store.fixLevels(plan.tasks);
      });
      break;
    }
  }
}

// ---------- dialogs ----------

function showPlans() {
  const list = store.listPlans();
  const current = state.readOnly ? null : state.plan?.id;
  $('#plan-list').innerHTML = list.length ? list.map(p => `
    <li data-id="${esc(p.id)}" class="${p.id === current ? 'current' : ''}">
      <button class="link" data-act="open">${esc(p.name)}</button>
      <span class="hint">${p.updated ? new Date(p.updated).toLocaleString() : ''}${p.id === current ? ' · open' : ''}</span>
      <button data-act="delete" class="danger" title="Delete this plan from this browser">Delete</button>
    </li>`).join('') : '<li class="hint">No saved plans in this browser.</li>';
  $('#dlg-plans').showModal();
}

function showSettings() {
  const f = $('#settings-form');
  f.name.value = state.plan.name;
  f.start.value = state.plan.start;
  f.holidays.value = state.plan.holidays.map(h => `${h.date}${h.label ? ' ' + h.label : ''}`).join('\n');
  $('#dlg-settings').showModal();
}

function saveSettings() {
  const f = $('#settings-form');
  const start = f.start.value;
  if (parseISO(start) === null) return toast('Enter a valid project start date.', 'error');
  const holidays = [];
  const bad = [];
  for (const line of f.holidays.value.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const [date, ...rest] = s.split(/\s+/);
    if (parseISO(date) === null) bad.push(s);
    else holidays.push({ date, label: rest.join(' ') });
  }
  holidays.sort((a, b) => a.date.localeCompare(b.date));
  commit(plan => {
    plan.name = f.name.value.trim() || 'Untitled project';
    plan.start = start;
    plan.holidays = holidays;
  });
  if (bad.length) toast(`Ignored ${bad.length} line(s) that did not start with a YYYY-MM-DD date.`, 'error');
}

async function showShare() {
  if (!('CompressionStream' in window)) return toast('This browser cannot create share links. Use “Save file” instead.', 'error');
  try {
    const frag = await store.encodeShare(state.plan);
    const url = `${location.origin}${location.pathname}#${frag}`;
    $('#share-url').value = url;
    $('#share-size').textContent = `Link length: ${url.length.toLocaleString()} characters.`
      + (url.length > 8000 ? ' Some email and chat apps truncate very long links; if it fails, send the plan file instead.' : '');
    $('#dlg-share').showModal();
    $('#share-url').select();
  } catch (e) {
    toast(`Could not create link: ${e.message}`, 'error');
  }
}

function printGantt() {
  const s = state.sched;
  $('#print-area').innerHTML = `<div class="print-title"><h1>${esc(state.plan.name)}</h1>
    <p>${fmtDate(s.start)} – ${fmtDate(s.finish)} · ${s.workdays} working days · Critical path in red · Printed ${new Date().toLocaleDateString()}</p></div>
    ${ganttPrintSVG(state.plan, s, state.zoom)}`;
  document.documentElement.dataset.theme = 'light'; // print in light colors even in dark mode
  window.print();
}

async function importFile(file) {
  try {
    const plan = store.normalize(JSON.parse(await file.text()));
    if (store.listPlans().some(p => p.id === plan.id)) {
      if (!confirm(`A plan with this ID (“${store.loadPlan(plan.id)?.name}”) already exists in this browser.\n\nOK = replace it with the file\nCancel = keep both (import as a copy)`)) {
        plan.id = store.uid();
        plan.name += ' (copy)';
      }
    }
    store.savePlan(plan);
    openPlan(plan);
    toast(`Opened “${plan.name}”.`);
  } catch (e) {
    toast(e instanceof SyntaxError ? 'That file is not valid JSON.' : e.message, 'error');
  }
}

function leaveShared() {
  history.replaceState(null, '', location.pathname + location.search);
  openPlan(loadInitialPlan());
}

function loadInitialPlan() {
  const last = store.lastPlanId();
  let plan = (last && store.loadPlan(last)) || store.listPlans().map(p => store.loadPlan(p.id)).find(Boolean);
  if (!plan) {
    plan = samplePlan();
    store.savePlan(plan);
  }
  return plan;
}

// ---------- events ----------

function wireEvents() {
  const tbody = $('#tbody');

  tbody.addEventListener('focusin', e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) select(Number(tr.dataset.id));
  });
  tbody.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = Number(tr.dataset.id);
    select(id);
    if (e.target.closest('[data-act="unpin"]')) {
      commit(plan => { plan.tasks.find(t => t.id === id).manualStart = null; });
    }
  });
  // Commit when a cell loses focus, after focus has landed on its new target
  tbody.addEventListener('focusout', e => {
    const input = e.target;
    if (!input.matches?.('input[data-f]') || input.readOnly) return;
    if (input.value === input.dataset.orig) return;
    const id = Number(input.closest('tr').dataset.id);
    const { f } = input.dataset;
    const { value } = input;
    input.dataset.orig = value;
    setTimeout(() => applyEdit(id, f, value), 0);
  });
  tbody.addEventListener('keydown', e => {
    const input = e.target;
    if (!input.matches?.('input[data-f]')) return;
    const tr = input.closest('tr');
    if (e.key === 'Escape') {
      input.value = input.dataset.orig;
      input.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const next = (e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling)
        ?.querySelector(`input[data-f="${input.dataset.f}"]`);
      if (next) next.focus();
      else if (!e.shiftKey && !state.readOnly && input.dataset.f === 'name') {
        input.blur();
        setTimeout(() => runCommand('add'), 0);
      } else input.blur();
    }
  });

  $('#gantt-pane').addEventListener('click', e => {
    const el = e.target.closest('[data-id]');
    if (el) select(Number(el.dataset.id));
  });
  $('#gantt-pane').addEventListener('dblclick', e => {
    const el = e.target.closest('[data-id]');
    if (!el || state.readOnly) return;
    if (state.view === 'gantt') { state.view = 'split'; savePrefs(); render(); }
    document.querySelector(`#tbody tr[data-id="${el.dataset.id}"] input[data-f="name"]`)?.focus();
  });

  document.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => runCommand(b.dataset.cmd)));
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    savePrefs();
    render();
  }));
  $('#zoom').addEventListener('change', e => {
    state.zoom = e.target.value;
    savePrefs();
    render({ scrollGantt: true });
  });

  $('#plan-name').addEventListener('click', () => state.readOnly ? null : showSettings());
  $('#btn-settings').addEventListener('click', showSettings);
  $('#btn-plans').addEventListener('click', showPlans);
  $('#btn-export').addEventListener('click', () => {
    store.downloadText(`${store.safeFilename(state.plan.name)}.json`, store.planToJSON(state.plan));
  });
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
  });
  $('#btn-share').addEventListener('click', showShare);
  $('#btn-print').addEventListener('click', printGantt);
  $('#btn-help').addEventListener('click', () => $('#dlg-help').showModal());

  $('#settings-form').addEventListener('submit', e => {
    if (e.submitter?.value === 'save') saveSettings();
  });

  $('#plan-list').addEventListener('click', e => {
    const li = e.target.closest('li[data-id]');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!li || !act) return;
    const id = li.dataset.id;
    if (act === 'open') {
      const plan = store.loadPlan(id);
      if (!plan) return toast('That plan could not be loaded.', 'error');
      history.replaceState(null, '', location.pathname + location.search);
      store.savePlan(plan); // marks it most recent
      openPlan(plan);
      $('#dlg-plans').close();
    } else if (act === 'delete') {
      const p = store.loadPlan(id);
      if (!confirm(`Delete “${p?.name ?? 'this plan'}” from this browser? This cannot be undone.\n\nTip: use “Save file” first if you want a backup.`)) return;
      store.deletePlan(id);
      if (!state.readOnly && state.plan.id === id) openPlan(loadInitialPlan());
      showPlans();
    }
  });
  $('#btn-new-plan').addEventListener('click', () => {
    const plan = store.newPlan();
    store.savePlan(plan);
    history.replaceState(null, '', location.pathname + location.search);
    openPlan(plan);
    $('#dlg-plans').close();
    showSettings();
  });
  $('#btn-new-sample').addEventListener('click', () => {
    const plan = samplePlan();
    store.savePlan(plan);
    history.replaceState(null, '', location.pathname + location.search);
    openPlan(plan);
    $('#dlg-plans').close();
  });

  $('#btn-copy-share').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#share-url').value);
      toast('Link copied.');
    } catch {
      $('#share-url').select();
      toast('Press Ctrl/⌘+C to copy the selected link.');
    }
  });

  $('#btn-save-copy').addEventListener('click', () => {
    const plan = { ...state.plan, id: store.uid() };
    store.savePlan(plan);
    history.replaceState(null, '', location.pathname + location.search);
    openPlan(plan);
    toast(`Saved “${plan.name}” to your plans.`);
  });
  $('#btn-close-shared').addEventListener('click', leaveShared);

  document.querySelectorAll('dialog .close').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.key.toLowerCase() !== 'z' && e.key.toLowerCase() !== 'y') return;
    const el = document.activeElement;
    // Let an input undo its own uncommitted typing
    if (el?.matches?.('input, textarea') && el.value !== el.dataset.orig) return;
    if (document.querySelector('dialog[open]') || state.readOnly) return;
    e.preventDefault();
    if (e.key.toLowerCase() === 'y' || e.shiftKey) redo(); else undo();
  });

  window.addEventListener('hashchange', loadFromHash);
  window.addEventListener('afterprint', () => {
    $('#print-area').innerHTML = '';
    delete document.documentElement.dataset.theme;
  });
}

async function loadFromHash() {
  if (!location.hash.startsWith('#share=')) return false;
  try {
    const plan = await store.decodeShare(location.hash);
    openPlan(plan, { readOnly: true });
    return true;
  } catch {
    toast('This share link is damaged or incomplete.', 'error');
    return false;
  }
}

// ---------- start ----------

async function init() {
  loadPrefs();
  renderTableHead($('#thead'));
  wireEvents();
  if (!store.storageAvailable()) {
    toast('Browser storage is unavailable (private mode?). Use “Save file” to keep your work.', 'error');
  }
  if (!(await loadFromHash())) openPlan(loadInitialPlan());
}

init();
