// Application controller: state, editing commands, persistence, and views.

import { parseISO, toISO } from './calendar.js';
import { schedule, durationBetween, linksOf, hiddenIds, nearCriticalDays } from './schedule.js';
import { renderGantt, ganttPrintSVG, ganttStandaloneSVG, scrollToDay, esc, LABEL_W } from './gantt.js';
import { renderTable, renderTableHead, parseDuration, parsePredList, COLUMNS, columnWidths, applyColumnWidths } from './table.js';
import * as store from './storage.js';
import { samplePlan } from './sample.js';
import { attachReorder } from './reorder.js';
import { planToCSV, csvToPlan, csvTemplate, csvDate } from './csv.js';
import { tablePrintHTML, tableStandaloneSVG } from './tableexport.js';
import { renderPert, pertPrintSVG, pertStandaloneSVG } from './pert.js';
import { RepoApi, RepoSession, repoToken } from './repo.js';
import { parseSlug, repoUrl, codespacesUrl, pageRepo, pageBundlePath, loadBundle } from './site.js';

const $ = sel => document.querySelector(sel);
const PREFS_KEY = 'projectplanner.prefs';
const PHONE = window.matchMedia('(max-width: 700px)'); // narrow (portrait phone)
// Compact layout (drawer instead of toolbars): keep in sync with style.css
const COMPACT = window.matchMedia('(max-width: 700px), (max-height: 500px)');
const SHORT = window.matchMedia('(max-height: 500px)'); // landscape phone: no room for split views
const VIEWS = ['table', 'gantt', 'pert', 'split', 'split-pert']; // split = Table/Gantt
const showsPert = () => state.view === 'pert' || state.view === 'split-pert';
// Which views a plan includes (Settings). Table is always available.
const ganttOn = () => state.plan.showGantt !== false;
const pertOn = () => state.plan.showPert !== false;
const isSplit = v => v === 'split' || v === 'split-pert';
const viewAllowed = v => (v !== 'gantt' && v !== 'split' || ganttOn()) && (v !== 'pert' && v !== 'split-pert' || pertOn())
  && !(SHORT.matches && isSplit(v));
// What Print / Export → PNG image output: the table on the Table tab, the
// chart on a chart or split tab, else whichever chart is included.
const chartKind = () => state.view === 'table' ? 'table'
  : showsPert() ? 'pert' : ganttOn() ? 'gantt' : pertOn() ? 'pert' : null;
const KIND_LABEL = { table: 'task table', gantt: 'Gantt chart', pert: 'PERT diagram' };

const state = {
  plan: null,
  sched: null,
  selectedId: null,
  readOnly: false,
  repo: null,    // RepoSession when the plan lives in a git clone (served by server/serve.py)
  git: null,     // last git status from the helper
  locked: false, // true while syncing: no edits
  colW: {},          // table column widths the user dragged (px), by field
  ganttLabelW: null, // Gantt task-name column width the user dragged, or default
  hidden: new Set(), // ids of rows inside collapsed summaries (recomputed by render)
  view: 'split',
  zoom: 'day',
  undo: [],
  redo: [],
};

// ---------- preferences (per browser) ----------

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (VIEWS.includes(p.view)) state.view = p.view;
    if (['day', 'week', 'month'].includes(p.zoom)) state.zoom = p.zoom;
    if (p.colW && typeof p.colW === 'object') state.colW = p.colW;
    if (Number.isFinite(p.ganttLabelW)) state.ganttLabelW = clampLabelW(p.ganttLabelW);
  } catch { /* defaults */ }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ view: state.view, zoom: state.zoom, colW: state.colW, ganttLabelW: state.ganttLabelW }));
  } catch { /* ignore */ }
}

// ---------- column widths (per browser) ----------
const LABEL_MIN = 120, LABEL_MAX = 500;
const clampLabelW = w => Math.round(Math.min(LABEL_MAX, Math.max(LABEL_MIN, w)));
// Gantt task-name column: fixed narrow on phones, else the user's or default
const ganttLabelW = () => (PHONE.matches ? 150 : state.ganttLabelW ?? LABEL_W);
// Table column widths as drawn on screen (Notes includes the spare width it
// absorbs), falling back to the configured widths if the table is hidden
function screenColumnWidths() {
  const out = columnWidths(state.colW);
  for (const th of document.querySelectorAll('#thead th[data-col]')) {
    const w = th.getBoundingClientRect().width;
    if (w > 0) out[th.dataset.col] = w;
  }
  return out;
}
// Each table column's on-screen width relative to its default, for exports
function columnScale() {
  const w = columnWidths(state.colW), out = {};
  for (const c of COLUMNS) out[c.f] = w[c.f] / c.w;
  return out;
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

// ---------- tooltips ----------
// Native title tooltips need a ~1 s hover, often don't appear (Safari with
// the window unfocused) and never appear on touch screens. Elements with
// data-tip get an immediate tooltip on hover, keyboard focus, or tap.

function showTip(el) {
  if (document.body.classList.contains('dragging-row')) return hideTip();
  const tip = $('#tip');
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
  const below = r.bottom + 6 + t.height <= window.innerHeight - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? r.bottom + 6 : r.top - 6 - t.height}px`;
}
function hideTip() { $('#tip').hidden = true; }

function wireTips() {
  const over = e => { const el = e.target.closest?.('[data-tip]'); if (el) showTip(el); else hideTip(); };
  document.addEventListener('pointerover', over);
  document.addEventListener('focusin', over);
  document.addEventListener('focusout', hideTip);
  // A mouse press (click or the start of a drag) dismisses it; a touch tap shows it
  document.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') hideTip(); });
  document.addEventListener('scroll', hideTip, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
}

// ---------- drop-down menu ----------
// The menu is positioned under its button but lives at the document level,
// so the header's sideways scrolling on phones can't clip it.

function wireMenu(button, menu) {
  const items = () => [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const close = (refocus = false) => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  };
  const open = () => {
    hideTip();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const r = button.getBoundingClientRect(), m = menu.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8))}px`;
    items()[0]?.focus();
  };
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  // Choosing an item closes the menu; the item's own handler does the work
  menu.addEventListener('click', e => { if (e.target.closest('[role="menuitem"]')) close(); });
  menu.addEventListener('keydown', e => {
    const list = items(), k = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(k + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(k - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') close();
  });
  document.addEventListener('pointerdown', e => {
    if (!menu.contains(e.target) && !button.contains(e.target)) close();
  });
  window.addEventListener('resize', () => close());
  document.addEventListener('scroll', e => { if (!menu.contains(e.target)) close(); }, true);
}

// ---------- drawer (compact layout) ----------
// On phones the toolbars are replaced by a slide-in drawer. Its items either
// carry data-cmd (handled with the toolbar buttons), data-goview, or
// data-proxy="#id" to click the matching desktop control, so behaviour is
// defined once.

function syncDrawerSelection() {
  const r = state.sched?.byId.get(state.selectedId);
  const t = state.plan?.tasks.find(x => x.id === state.selectedId);
  $('#dr-sel').textContent = r ? `· row ${r.row} ${t.name || '(unnamed)'}` : '';
}

// Mirror the desktop controls' state into the drawer (called from render)
function syncDrawer() {
  $('#dr-plan').textContent = state.plan.name;
  syncDrawerSelection();
  document.querySelectorAll('#dr-views [data-goview]').forEach(b => {
    b.hidden = !viewAllowed(b.dataset.goview);
    b.setAttribute('aria-checked', b.dataset.goview === state.view);
  });
  document.querySelectorAll('#drawer [data-proxy]').forEach(b => {
    const target = $(b.dataset.proxy);
    if (target) b.disabled = target.disabled;
  });
}

function openDrawer() {
  hideTip();
  const d = $('#drawer'), s = $('#scrim');
  d.hidden = s.hidden = false;
  requestAnimationFrame(() => { d.classList.add('open'); s.classList.add('open'); });
  $('#btn-drawer').setAttribute('aria-expanded', 'true');
  d.querySelector('.dr-close').focus();
}
function closeDrawer({ refocus = true } = {}) {
  const d = $('#drawer'), s = $('#scrim');
  if (d.hidden) return;
  d.classList.remove('open'); s.classList.remove('open');
  $('#btn-drawer').setAttribute('aria-expanded', 'false');
  const done = () => { d.hidden = s.hidden = true; };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setTimeout(done, 200);
  if (refocus) $('#btn-drawer').focus({ preventScroll: true });
}

function wireDrawer() {
  const d = $('#drawer');
  $('#btn-drawer').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', () => closeDrawer());
  d.querySelector('.dr-close').addEventListener('click', () => closeDrawer());
  d.addEventListener('click', e => {
    const b = e.target.closest('button, a');
    if (!b || b.disabled) return;
    if (b.dataset.goview) {
      $(`.tabs button[data-view="${b.dataset.goview}"]`).click();
      closeDrawer();
    } else if (b.dataset.proxy) {
      closeDrawer({ refocus: false }); // dialogs and pickers take focus themselves
      $(b.dataset.proxy).click();
    } else if (b.dataset.cmd) {
      // Edits keep the drawer open in landscape so repeated Indent / Move up
      // can be watched beside it; in portrait the drawer covers the rows, and
      // adding a task needs the keyboard on its name.
      if (PHONE.matches || 'close' in b.dataset) closeDrawer({ refocus: false });
      else syncDrawerSelection();
    } else if (b.tagName === 'A') {
      closeDrawer({ refocus: false });
    }
  });
  d.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    // Keep keyboard focus inside the open drawer
    const f = [...d.querySelectorAll('button, a')].filter(x => !x.disabled && x.offsetParent !== null);
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  // Swipe left to close
  let x0 = null, y0 = 0;
  d.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  d.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (dx < -60 && Math.abs(dy) < Math.abs(dx)) closeDrawer();
    x0 = null;
  }, { passive: true });
  // Leaving the compact layout (rotation, resize) closes it; a short screen
  // may hide split views, so re-render
  const relayout = () => { if (!COMPACT.matches) closeDrawer({ refocus: false }); render(); };
  COMPACT.addEventListener('change', relayout);
  SHORT.addEventListener('change', relayout);
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
  if (state.repo) { // repo mode: the clone's data/ is the store; collapse state stays per person
    saveCollapsed();
    state.repo.markDirty();
    return;
  }
  if (!store.savePlan(state.plan)) toast('Could not save to browser storage. Use Export → JSON file to keep your work.', 'error');
}

// Wrap every edit: snapshot for undo, mutate, save, re-render.
function commit(mutator) {
  if (state.readOnly || state.locked) return;
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
  if (state.locked) return;
  if (!state.undo.length) return toast('Nothing to undo');
  state.redo.push(JSON.stringify(state.plan));
  state.plan = JSON.parse(state.undo.pop());
  persist();
  render();
}
function redo() {
  if (state.locked) return;
  if (!state.redo.length) return toast('Nothing to redo');
  state.undo.push(JSON.stringify(state.plan));
  state.plan = JSON.parse(state.redo.pop());
  persist();
  render();
}

// ---------- repo mode ----------
// When served by server/serve.py the plan is data/ in this git clone. Edits are
// saved to disk automatically; Sync commits, pulls teammates' changes and pushes.
// Which groups are collapsed is a per-person view choice, kept in this browser.

const collapsedKey = id => `projectplanner.collapsed.${id}`;

function applyCollapsed(plan) {
  try {
    const ids = new Set(JSON.parse(localStorage.getItem(collapsedKey(plan.id)) || '[]'));
    for (const t of plan.tasks) t.collapsed = ids.has(t.id);
  } catch { /* all expanded */ }
  return plan;
}
function saveCollapsed() {
  try { localStorage.setItem(collapsedKey(state.plan.id), JSON.stringify(state.plan.tasks.filter(t => t.collapsed).map(t => t.id))); } catch { /* ignore */ }
}

// The plan changed under the user (a merge or a pull): show it, keep the selection.
function adoptPlan(plan) {
  applyCollapsed(plan);
  const keep = state.selectedId;
  state.plan = plan;
  state.selectedId = plan.tasks.some(t => t.id === keep) ? keep : plan.tasks[0]?.id ?? null;
  state.undo = [];
  state.redo = [];
  render();
}

// The header links to this project's repository, when we know it: from the page
// (published site) or from the helper (a clone).
function showRepoLink(repo) {
  for (const a of [$('#repo-link'), $('#dr-repo')]) { // header (desktop) and drawer (phone)
    if (!repo) { a.hidden = true; continue; }
    a.textContent = a.id === 'dr-repo' ? `${repo.slug} on GitHub ↗` : repo.slug;
    a.href = repoUrl(repo);
    a.hidden = false;
  }
}

const dataFiles = g => (g?.dirty || []).filter(p => p.startsWith('data/'));

function repoSaveText() {
  const r = state.repo;
  const disk = {
    saved: 'Saved to disk', dirty: 'Unsaved changes…', saving: 'Saving…',
    error: `<span class="warn-text">⚠ Not saved: ${esc(r.error || 'unknown error')}</span>`,
    conflict: '<span class="warn-text">⚠ Conflict: choose a version</span>',
  }[r.state];
  const g = state.git;
  if (!g) return disk;
  const n = dataFiles(g).length;
  const bits = [esc(g.branch)];
  if (n) bits.push(`${n} file${n > 1 ? 's' : ''} to commit`);
  if (g.ahead) bits.push(`${g.ahead} to push`);
  if (g.behind) bits.push(`${g.behind} to pull`);
  if (bits.length === 1) bits.push('in sync');
  return `${disk} · ${bits.join(' · ')}`;
}

function updateSyncButton() {
  const g = state.git, b = $('#btn-sync');
  b.classList.toggle('attention', !!g && (dataFiles(g).length > 0 || g.ahead > 0 || g.behind > 0));
}

// Git status refreshes run one at a time. A call returns a promise for a refresh
// that starts after the call, so `await refreshGit()` always sees fresh numbers.
let gitRun = Promise.resolve(), gitPending = null;
function refreshGit(full = true) {
  if (!state.repo) return Promise.resolve();
  if (gitPending && (gitPending.full || !full)) return gitPending.promise; // a queued refresh already covers this one
  const job = { full };
  job.promise = gitRun.then(async () => {
    if (gitPending === job) gitPending = null;
    try { state.git = await state.repo.api.status(job.full); } catch { /* keep the last known status */ }
    if (state.sched) renderStatus();
    updateSyncButton();
    showRepoLink(parseSlug(state.git?.repo));
  });
  gitPending = job;
  gitRun = job.promise;
  return job.promise;
}

function onRepoState(st) {
  if (state.sched) renderStatus();
  if (st === 'conflict') showDiskConflict();
  if (st === 'error') toast(`Could not save: ${state.repo.error}`, 'error');
  if (st === 'saved') refreshGit(false);
}

function showProblem(title, text, { reload = false } = {}) {
  $('#problem-title').textContent = title;
  $('#problem-body').textContent = text;
  $('#btn-problem-reload').hidden = !reload;
  const dlg = $('#dlg-problem');
  if (!dlg.open) dlg.showModal();
}

// A task named in a data/ path, for messages.
function taskLabel(path, ...sources) {
  if (path === 'data/plan.json') return 'Plan settings';
  for (const files of sources) {
    try { const name = JSON.parse(files[path]).name; if (name) return name; } catch { /* next */ }
  }
  return path.replace('data/tasks/', '').replace('.json', '');
}

function showDiskConflict() {
  const { mine, theirs, paths } = state.repo.conflict;
  const name = (files, p) => { try { return JSON.parse(files[p]).name || '(unnamed)'; } catch { return '(deleted)'; } };
  $('#conflict-list').innerHTML = paths.map(p => `
    <li class="conflict-item"><b>${esc(taskLabel(p, mine, theirs))}</b>
      <span class="side">Yours: ${esc(name(mine, p))}</span><span class="side">Other: ${esc(name(theirs, p))}</span></li>`).join('');
  const dlg = $('#dlg-conflict');
  if (!dlg.open) dlg.showModal();
}

function lockUI(on) {
  state.locked = on;
  document.body.classList.toggle('syncing', on);
  const b = $('#btn-sync');
  b.disabled = on;
  b.textContent = on ? 'Syncing…' : 'Sync';
  if (on) document.activeElement?.blur?.();
}

function defaultCommitMessage(files) {
  const tasks = files.filter(p => p.startsWith('data/tasks/')).length;
  const parts = [];
  if (files.includes('data/plan.json')) parts.push('plan settings');
  if (tasks) parts.push(`${tasks} task${tasks > 1 ? 's' : ''}`);
  return `Update ${parts.join(' and ') || 'plan'}`;
}

async function startSync() {
  const s = state.repo, btn = $('#btn-sync');
  if (!s || state.locked || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Checking…'; // saving and asking GitHub what is new can take a moment
  let g, files;
  try {
    try { await s.flush(); } catch (e) { return toast(e.message, 'error'); }
    if (s.state !== 'saved') return;
    await refreshGit(true);
    g = state.git;
    if (!g) return toast('Could not read the git status.', 'error');
    files = dataFiles(g);
  } finally {
    if (!state.locked) { btn.disabled = false; btn.textContent = 'Sync'; }
  }
  if (!files.length) { // nothing to commit: only pull and/or push
    if (!g.ahead && !g.behind) return toast('Already in sync with GitHub.');
    return runSync('Sync');
  }
  $('#sync-summary').textContent = `${files.length} changed file${files.length > 1 ? 's' : ''} will be committed on branch ${g.branch}`
    + (g.behind ? `; ${g.behind} commit${g.behind > 1 ? 's' : ''} from your teammates will be pulled in.` : '.');
  const f = $('#sync-form');
  f.message.value = defaultCommitMessage(files);
  $('#dlg-sync').showModal();
  f.message.select();
}

async function runSync(message) {
  const s = state.repo;
  const behind = state.git?.behind || 0;
  lockUI(true);
  try {
    const r = await s.sync(message.trim() || 'Sync');
    if (r.status === 'ok') {
      toast(`Synced with GitHub${behind ? `; pulled ${behind} new commit${behind > 1 ? 's' : ''}` : ''}.`);
    } else if (r.status === 'conflict') {
      await startMerge();
    } else if (r.status === 'error') {
      showProblem('Sync did not complete', r.message);
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    lockUI(false);
    refreshGit(true);
  }
}

// ---- resolving a conflict with a teammate ----

let mergeState = null;

function taskName(id) { return state.plan.tasks.find(t => t.id === id)?.name || id; }

// How a field's value reads to a person.
function describeValue(c, v) {
  if (c.field === '*') return v ? `Keep the task “${v.name || '(unnamed)'}”` : 'Delete the task';
  if (v === undefined || v === null) return c.key !== undefined ? 'Remove it' : '(empty)';
  switch (c.field) {
    case 'preds': return `${taskName(v.id)}, ${{ FS: 'finish-to-start', SS: 'start-to-start', FF: 'finish-to-finish' }[v.type] || v.type}`;
    case 'holidays': return `${v.date}${v.label ? ' ' + v.label : ''}`;
    case 'duration': return `${v} day${v === 1 ? '' : 's'}`;
    case 'pct': return `${v}%`;
    case 'nearCritical': return v === 0 ? 'off' : `${v} working day${v === 1 ? '' : 's'} of float or less`;
    case 'level': return v === 0 ? 'top level' : `indented ${v} level${v > 1 ? 's' : ''}`;
    case 'rank': return 'moved to a different place';
    case 'manualStart': return v || '(not pinned)';
    case 'satOff': case 'sunOff': case 'showGantt': case 'showPert': return v ? 'yes' : 'no';
    default: return String(v) === '' ? '(empty)' : String(v);
  }
}

function clashLabel(c) {
  if (c.field === '*') return 'The task was deleted by one of you and changed by the other';
  if (c.field === 'preds') return `Predecessor “${taskName(c.key)}”`;
  if (c.field === 'holidays') return `Holiday ${c.key}`;
  return c.label;
}

function renderMergeDialog(m) {
  $('#merge-body').innerHTML = m.items.filter(a => a.conflicts.length).map((a, i) => `
    <section class="merge-item">
      <h3>${esc(a.title)}</h3>
      ${a.auto ? `<p class="hint">${a.auto} other change${a.auto > 1 ? 's' : ''} merged automatically.</p>` : ''}
      ${a.conflicts.map((c, j) => `
        <fieldset class="clash" data-path="${esc(a.path)}" data-cid="${esc(c.id)}">
          <legend>${esc(clashLabel(c))}</legend>
          <label class="check"><input type="radio" name="m${i}_${j}" value="ours"> <span><b>Yours</b>: ${esc(describeValue(c, c.ours))}</span></label>
          <label class="check"><input type="radio" name="m${i}_${j}" value="theirs"> <span><b>Theirs</b>: ${esc(describeValue(c, c.theirs))}</span></label>
        </fieldset>`).join('')}
    </section>`).join('');
  $('#btn-merge-finish').disabled = true;
}

function mergeChoices() {
  const choices = {}, sets = [...document.querySelectorAll('#merge-body fieldset.clash')];
  let complete = true;
  for (const fs of sets) {
    const picked = fs.querySelector('input:checked')?.value;
    if (!picked) { complete = false; continue; }
    (choices[fs.dataset.path] ||= {})[fs.dataset.cid] = picked;
  }
  return { choices, complete };
}

async function startMerge() {
  let m;
  try { m = await state.repo.beginMerge(); } catch (e) { return showProblem('Sync did not complete', e.message); }
  if (m.unresolvable.length) {
    const names = m.unresolvable.map(p => `• ${p.startsWith('data/') ? taskLabel(p, state.repo.base) : p}`).join('\n');
    return showProblem('This conflict cannot be resolved in the app',
      `These files conflict and are not plan data the app can merge:\n${names}\n\nResolve them in the terminal (git pull, fix the files, git commit), then reload this page.`);
  }
  if (!m.items.some(a => a.conflicts.length)) return completeMerge(m, {}); // everything merges by itself
  mergeState = m;
  renderMergeDialog(m);
  $('#dlg-merge').showModal();
}

async function completeMerge(m, choices) {
  lockUI(true);
  try {
    const r = await state.repo.finishMerge(m, choices, 'Merge teammate changes');
    if (r.status === 'ok') toast('Merged your teammate’s changes and pushed.');
    else if (r.status === 'changed') showProblem('The remote changed again', 'Someone pushed while you were deciding. Nothing was changed. Press Sync again to see the new differences.');
    else showProblem('The merge did not complete', r.message);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    mergeState = null;
    lockUI(false);
    refreshGit(true);
  }
}

// ---- the published site, with a read-only plan the owner opted in to publish ----

function openViewer(bundle, repo) {
  document.body.classList.add('viewer');
  openPlan(applyCollapsed(bundle.plan), { readOnly: true });
  $('#readonly-banner').hidden = true; // that banner is for share links
  const when = bundle.generated ? ` on ${new Date(bundle.generated).toLocaleDateString()}` : '';
  const at = bundle.commit ? ` (version ${bundle.commit})` : '';
  $('#viewer-text').innerHTML = `You are viewing a <strong>read-only copy</strong> of the project plan, as last published${esc(when)}${esc(at)}.`;
  $('#viewer-banner').hidden = false;
  if (repo) {
    const b = $('#btn-viewer-edit');
    b.hidden = $('#dr-viewer-edit').hidden = false;
    b.onclick = () => window.open(codespacesUrl(repo), '_blank', 'noopener');
  }
}

async function initRepo(token) {
  const session = new RepoSession(new RepoApi(token), { getPlan: () => state.plan, adopt: adoptPlan, onState: onRepoState });
  state.repo = session;
  let plan, created = false;
  try {
    plan = await session.load();
    if (!plan) { // a clone with no plan yet: start this project's plan
      plan = store.newPlan();
      await session.create(plan);
      created = true;
    }
  } catch (e) {
    // Never fall back to browser storage here: that would quietly fork the plan.
    openPlan(store.newPlan(), { readOnly: true });
    $('#readonly-banner').hidden = true;
    return showProblem('Cannot open this project', e.message, { reload: true });
  }
  document.body.classList.add('repo-mode');
  $('#btn-sync').hidden = $('#dr-sync').hidden = false;
  openPlan(applyCollapsed(plan));
  if (created) showSettings();
  refreshGit(true);
  setInterval(() => { if (!document.hidden) refreshGit(true); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) session.flush().catch(() => {});
    else session.refresh().catch(() => {}).then(() => refreshGit(true));
  });
  window.addEventListener('beforeunload', e => {
    if (session.state !== 'saved') { e.preventDefault(); e.returnValue = ''; }
  });
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
  // The selected task is always visible: expand any collapsed group hiding it
  // (e.g. after adding or moving a task into one, or an undo).
  for (let p = state.sched.byId.get(state.selectedId)?.parent; p != null; p = state.sched.byId.get(p).parent) {
    plan.tasks.find(t => t.id === p).collapsed = false;
  }
  state.hidden = hiddenIds(plan, state.sched);

  // Remember focus so the table can be rebuilt under the cursor
  const active = document.activeElement;
  const focusRow = active?.closest?.('tr[data-id]')?.dataset.id;
  const focusField = active?.dataset?.f;

  hideTip(); // its anchor is about to be replaced
  $('#plan-name').textContent = plan.name;
  document.title = `${plan.name} – Project Planner`;
  // A view this plan excludes falls back to the table (prefs keep the choice
  // for plans that include it)
  if (!viewAllowed(state.view)) {
    // A split view on a short screen becomes its chart alone; anything else, the table
    const chart = state.view === 'split' ? 'gantt' : state.view === 'split-pert' ? 'pert' : null;
    state.view = chart && viewAllowed(chart) ? chart : 'table';
  }
  $('#main').className = `view-${state.view}`;
  document.querySelectorAll('.tabs button').forEach(b => {
    b.setAttribute('aria-selected', b.dataset.view === state.view);
    b.hidden = !viewAllowed(b.dataset.view);
  });
  const kind = chartKind();
  for (const b of [$('#btn-png'), $('#btn-print')]) {
    b.disabled = !kind;
    b.title = kind ? b.dataset.title : 'Turn on Gantt or PERT in Settings to export a chart';
  }
  $('#png-kind').textContent = kind
    ? `The ${KIND_LABEL[kind]}${kind === 'gantt' ? ' at the current zoom' : ''}, for reports and slides`
    : 'No chart: turn on Gantt or PERT in Settings';
  $('#print-kind').textContent = kind ? `The ${KIND_LABEL[kind]}, or save it as a PDF` : 'No chart: turn on Gantt or PERT in Settings';
  $('#zoom').value = state.zoom;

  renderTable($('#tbody'), plan, state.sched, { selectedId: state.selectedId, readOnly: state.readOnly, hidden: state.hidden });
  applyColumnWidths($('table.tasks'), columnWidths(state.colW));
  drawGantt({ scrollGantt });
  if (showsPert()) {
    const pp = $('#pert-pane');
    const keep = { left: pp.scrollLeft, top: pp.scrollTop };
    renderPert(pp, plan, state.sched, { selectedId: state.selectedId, hidden: state.hidden });
    pp.scrollLeft = keep.left; pp.scrollTop = keep.top;
  }
  $('#zoom').disabled = showsPert(); // the network diagram has no time scale

  if (focusRow && focusField) {
    const el = document.querySelector(`#tbody tr[data-id="${focusRow}"] input[data-f="${focusField}"]`);
    if (el) el.focus({ preventScroll: true });
  }
  renderStatus();
  updateUndoButtons();
  syncDrawer();
}

// The Gantt pane alone (also redrawn live while its name column is dragged)
function drawGantt({ scrollGantt = false } = {}) {
  const pane = $('#gantt-pane');
  const { scrollLeft, scrollTop } = pane;
  const LW = ganttLabelW();
  renderGantt(pane, state.plan, state.sched, { zoom: state.zoom, selectedId: state.selectedId, hidden: state.hidden, labelW: LW });
  // Keep the floating zoom control clear of the pane's vertical scrollbar
  $('#gantt-wrap').style.setProperty('--sbw', `${pane.offsetWidth - pane.clientWidth}px`);
  $('#gantt-rs').style.left = `${LW}px`;
  if (scrollGantt) scrollToDay(pane, state.sched, state.zoom, state.sched.startDay);
  else { pane.scrollLeft = scrollLeft; pane.scrollTop = scrollTop; }
}

// Drag a handle to resize; double-click resets. onMove gets the new width
// (start width + horizontal travel); onEnd runs once on release.
function dragResize(handle, startWidth, { onMove, onEnd, onReset }) {
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // not a row-reorder drag
    const x0 = e.clientX, w0 = startWidth(handle);
    let frame = 0, last = w0;
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    document.body.classList.add('resizing');
    handle.classList.add('active');
    const move = ev => {
      last = w0 + ev.clientX - x0;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => onMove(last));
    };
    const up = () => {
      cancelAnimationFrame(frame);
      onMove(last);
      document.body.classList.remove('resizing');
      handle.classList.remove('active');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      onEnd();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', e => { e.stopPropagation(); onReset(); });
  handle.addEventListener('click', e => e.stopPropagation());
}

function wireResizing() {
  const table = $('table.tasks');
  for (const h of document.querySelectorAll('#thead .col-rs')) {
    const f = h.dataset.col;
    dragResize(h, () => h.parentElement.getBoundingClientRect().width, {
      onMove: w => { state.colW[f] = w; applyColumnWidths(table, columnWidths(state.colW)); },
      onEnd: () => { state.colW[f] = columnWidths(state.colW)[f]; savePrefs(); },
      onReset: () => { delete state.colW[f]; applyColumnWidths(table, columnWidths(state.colW)); savePrefs(); },
    });
  }
  dragResize($('#gantt-rs'), () => ganttLabelW(), {
    onMove: w => { state.ganttLabelW = clampLabelW(w); drawGantt(); },
    onEnd: savePrefs,
    onReset: () => { state.ganttLabelW = null; drawGantt(); savePrefs(); },
  });
}

function renderStatus() {
  const s = state.sched;
  const leaves = s.rows.filter(r => !r.summary);
  const crit = leaves.filter(r => r.critical).length;
  const near = leaves.filter(r => r.near).length;
  const issues = s.rows.filter(r => r.issues.length).length;
  const done = leaves.length
    ? Math.round(leaves.reduce((a, r) => a + r.pct * Math.max(r.duration, 1), 0) / leaves.reduce((a, r) => a + Math.max(r.duration, 1), 0))
    : 0;
  $('#status').innerHTML = [
    `<span><b>Start</b> ${fmtDate(s.start)}</span>`,
    `<span><b>Finish</b> ${fmtDate(s.finish)}</span>`,
    `<span><b>${s.workdays}</b> working days</span>`,
    `<span><b>${leaves.length}</b> tasks, <span class="crit-text">${crit} critical</span>${near ? `, <span class="near-text">${near} near-critical</span>` : ''}</span>`,
    `<span><b>${done}%</b> complete</span>`,
    issues ? `<span class="warn-text">⚠ ${issues} warning${issues > 1 ? 's' : ''}</span>` : '',
    `<span class="save-state">${state.readOnly ? 'Read-only' : state.repo ? repoSaveText() : 'Saved in this browser'}</span>`,
  ].join('');
  $('#dr-status').innerHTML = $('#status').innerHTML;
}

function updateUndoButtons() {
  document.querySelectorAll('[data-cmd="undo"]').forEach(b => { b.disabled = !state.undo.length; });
  document.querySelectorAll('[data-cmd="redo"]').forEach(b => { b.disabled = !state.redo.length; });
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
  document.querySelectorAll('#pert-pane .pt-node.selected').forEach(el => el.classList.remove('selected'));
  document.querySelector(`#pert-pane .pt-node[data-id="${id}"]`)?.classList.add('selected');
  syncDrawerSelection();
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
        const links = parsePredList(value);
        if (links === null) return reject('Predecessors are row numbers with an optional link type, e.g. 2, 5SS, 7FF.');
        const preds = [];
        for (const { row: n, type } of links) {
          const p = plan.tasks[n - 1];
          if (!p) return reject(`There is no row ${n}.`);
          if (p.id === id) return reject('A task cannot be its own predecessor.');
          preds.push({ id: p.id, type });
        }
        t.preds = preds;
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

// True when inserting task id's subtree at index k would actually move it.
function canMove(id, k) {
  const tasks = state.plan.tasks;
  const i = tasks.findIndex(t => t.id === id);
  return i >= 0 && (k < i || k > subtreeEnd(tasks, i));
}

// Move task i and its subtasks so they land before what is now tasks[k]
// (k = tasks.length means the end). The moved task keeps its outline level
// where possible, clamped so it neither adopts the rows below as children nor
// sits deeper than the rows above allow.
function moveBlock(plan, i, k) {
  const tasks = plan.tasks;
  const end = subtreeEnd(tasks, i);
  if (k >= i && k <= end) return false;
  const block = tasks.splice(i, end - i);
  const at = k > i ? k - block.length : k;
  let above = tasks[at - 1];
  const below = tasks[at];
  const min = below ? below.level : 0;
  let max = above ? above.level + (below && below.level > above.level ? 1 : 0) : 0;
  if (above && state.hidden.has(above.id)) {
    // Dropped just below a collapsed group: become its sibling, not a hidden child
    let j = at - 1;
    while (j > 0 && state.hidden.has(tasks[j].id)) j--;
    max = tasks[j].level;
  }
  const delta = Math.min(max, Math.max(min, block[0].level)) - block[0].level;
  for (const t of block) t.level += delta;
  tasks.splice(at, 0, ...block);
  store.fixLevels(tasks);
}

function moveTask(id, k) {
  commit(plan => moveBlock(plan, plan.tasks.findIndex(t => t.id === id), k));
}

// Drag positions count visible rows only; convert one to a plan index.
function planIndex(visibleIndex) {
  const tasks = state.plan.tasks;
  const vis = tasks.filter(t => !state.hidden.has(t.id));
  return visibleIndex < vis.length ? tasks.indexOf(vis[visibleIndex]) : tasks.length;
}

// Collapse or expand a summary. This is a view change, so it is saved but not
// added to the undo history.
function toggleCollapse(id) {
  const i = state.plan.tasks.findIndex(t => t.id === id);
  if (i < 0 || !state.sched.byId.get(id).summary) return;
  const t = state.plan.tasks[i];
  t.collapsed = !t.collapsed;
  if (t.collapsed) {
    const end = subtreeEnd(state.plan.tasks, i);
    const sel = state.plan.tasks.findIndex(x => x.id === state.selectedId);
    if (sel > i && sel < end) state.selectedId = id;
  }
  persist();
  render();
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
        newId = store.newTaskId(plan);
        const t = store.blankTask(newId);
        if (i < 0) { plan.tasks.push(t); return; }
        const sel = plan.tasks[i];
        if (cmd === 'insert') {
          t.level = sel.level;
          plan.tasks.splice(i, 0, t);
        } else {
          // After the selected task's subtree, at the same level; or as first
          // child of an expanded summary
          const isSummary = !sel.collapsed && i + 1 < plan.tasks.length && plan.tasks[i + 1].level > sel.level;
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
        for (const t of plan.tasks) t.preds = linksOf(t).filter(p => p.id !== gone.id);
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
      // Step over the neighbouring sibling (with its subtasks); at the edge of
      // a group, step out of it (up) or into the next group (down).
      let k;
      if (cmd === 'up') {
        if (i === 0) return;
        k = i - 1;
        while (k > 0 && tasks[k].level > tasks[i].level) k--;
      } else {
        const e = subtreeEnd(tasks, i);
        if (e >= tasks.length) return;
        k = tasks[e].level === tasks[i].level ? subtreeEnd(tasks, e) : e + 1;
      }
      commit(plan => moveBlock(plan, i, k));
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
  f.satOff.checked = state.plan.satOff !== false;
  f.showGantt.checked = ganttOn();
  f.showPert.checked = pertOn();
  f.nearCritical.value = nearCriticalDays(state.plan);
  f.sunOff.checked = state.plan.sunOff !== false;
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
    plan.satOff = f.satOff.checked;
    plan.showGantt = f.showGantt.checked;
    plan.showPert = f.showPert.checked;
    plan.nearCritical = nearCriticalDays({ nearCritical: f.nearCritical.value === '' ? 0 : f.nearCritical.value });
    plan.sunOff = f.sunOff.checked;
  });
  if (bad.length) toast(`Ignored ${bad.length} line(s) that did not start with a YYYY-MM-DD date.`, 'error');
}

async function showShare() {
  if (!('CompressionStream' in window)) return toast('This browser cannot create share links. Use Export → JSON file instead.', 'error');
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
  if (!chartKind()) return;
  const s = state.sched;
  $('#print-area').innerHTML = `<div class="print-title"><h1>${esc(state.plan.name)}</h1>
    <p>${fmtDate(s.start)} – ${fmtDate(s.finish)} · ${s.workdays} working days · Critical path in red · Printed ${new Date().toLocaleDateString()}</p></div>
    ${{ table: () => tablePrintHTML(state.plan, s, state.hidden, screenColumnWidths()),
        pert: () => pertPrintSVG(state.plan, s, state.hidden),
        gantt: () => ganttPrintSVG(state.plan, s, state.zoom, state.hidden, state.ganttLabelW ?? LABEL_W) }[chartKind()]()}`;
  document.documentElement.dataset.theme = 'light'; // print in light colors even in dark mode
  window.print();
}

// The chart (Gantt and PERT) rules from style.css with light-theme colors substituted, so an
// exported image looks like the screen in light mode whatever the viewer uses.
function chartExportCSS() {
  const sheet = [...document.styleSheets].find(s => s.href?.endsWith('/style.css'));
  const rules = [...sheet.cssRules].filter(r => r instanceof CSSStyleRule);
  const vars = {};
  const root = rules.find(r => r.selectorText === ':root').style;
  for (let k = 0; k < root.length; k++) {
    if (root[k].startsWith('--')) vars[root[k]] = root.getPropertyValue(root[k]).trim();
  }
  return rules
    .filter(r => r.selectorText.split(',').every(s => /^\.(g|pt|tx)-/.test(s.trim())))
    .map(r => r.cssText.replace(/var\((--[\w-]+)\)/g, (m, v) => vars[v] ?? m))
    .join('\n');
}

// Browsers cap canvas size (Safari at ~16.7 Mpx), so very long charts are
// exported at a lower scale rather than failing.
const PNG_MAX_PIXELS = 16e6, PNG_MAX_SIDE = 16000;

async function exportPNG() {
  if (!chartKind()) return;
  const kind = chartKind(), css = chartExportCSS();
  const { svg, width, height } = kind === 'table' ? tableStandaloneSVG(state.plan, state.sched, css, state.hidden, columnScale())
    : kind === 'pert' ? pertStandaloneSVG(state.plan, state.sched, css, state.hidden)
    : ganttStandaloneSVG(state.plan, state.sched, state.zoom, css, state.hidden, state.ganttLabelW ?? LABEL_W);
  const scale = Math.min(2, PNG_MAX_SIDE / width, PNG_MAX_SIDE / height, Math.sqrt(PNG_MAX_PIXELS / (width * height)));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('the browser could not encode the image');
    store.downloadBlob(`${store.safeFilename(state.plan.name)}-${kind}.png`, blob);
    toast(scale < 1
      ? `Chart is very large, so it was exported at reduced resolution (${canvas.width}×${canvas.height}). Try a coarser zoom.`
      : `Exported ${canvas.width}×${canvas.height} PNG at the current zoom.`);
  } catch (e) {
    toast(`PNG export failed: ${e.message}`, 'error');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// In a project repository an imported file replaces the project's plan (git keeps the old
// version, and Undo works). A CSV carries only tasks, so the project's own name, holidays and
// settings are kept; a JSON file is a whole plan and replaces everything but the plan's id.
function replaceProjectPlan(plan, { source, tasksOnly }) {
  const cur = state.plan;
  if (tasksOnly) {
    Object.assign(plan, { name: cur.name, holidays: cur.holidays, satOff: cur.satOff, sunOff: cur.sunOff, showGantt: cur.showGantt, showPert: cur.showPert, nearCritical: cur.nearCritical });
  }
  const question = tasksOnly
    ? `Replace all ${cur.tasks.length} tasks in this project with the ${plan.tasks.length} from ${source}?\n\nThe project name, holidays and settings are kept. Git keeps the previous version, and Undo is available.`
    : `Replace this project's plan with “${plan.name}” from ${source}?\n\nGit keeps the previous version, and Undo is available.`;
  if (!confirm(question)) return false;
  plan.id = cur.id;
  state.undo.push(JSON.stringify(cur));
  state.redo = [];
  state.plan = plan;
  state.selectedId = plan.tasks[0]?.id ?? null;
  applyCollapsed(plan);
  persist();
  render({ scrollGantt: true });
  return true;
}

async function importFile(file) {
  const text = await file.text();
  // Go by content rather than the menu item, so a mislabelled file still opens
  const isJSON = /^\s*\{/.test(text.replace(/^\uFEFF/, ''));
  if (!isJSON) return importCSV(file, text);
  try {
    const plan = store.normalize(JSON.parse(text));
    if (state.repo) {
      if (replaceProjectPlan(plan, { source: `“${file.name}”`, tasksOnly: false })) toast(`Replaced the plan with “${plan.name}”.`);
      return;
    }
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

// A CSV becomes a new plan (it has no plan id, holidays, or settings).
function importCSV(file, text) {
  try {
    const name = file.name.replace(/\.[^.]+$/, '') || 'Imported plan';
    const { plan: raw, warnings } = csvToPlan(text, { name, parsePreds: parsePredList, isoDate: csvDate });
    const plan = store.normalize(raw);
    const n = plan.tasks.length;
    if (state.repo) {
      if (replaceProjectPlan(plan, { source: `“${file.name}”`, tasksOnly: true })) {
        toast(`Replaced the tasks with ${n} from “${file.name}”.${warnings.length ? ` Note: ${warnings.join('; ')}.` : ''} Start date comes from the file; check Settings.`, warnings.length ? 'error' : '');
      }
      return;
    }
    store.savePlan(plan);
    openPlan(plan);
    toast(`Imported ${n} task${n === 1 ? '' : 's'} from “${file.name}” as a new plan.`
      + (warnings.length ? ` Note: ${warnings.join('; ')}.` : '')
      + ' Holidays and weekend settings are not in a CSV; check Settings.', warnings.length ? 'error' : '');
  } catch (e) {
    // Explain, and offer a template in the layout the importer reads
    $('#import-error-msg').textContent = `“${file.name}”: ${e.message}`;
    $('#dlg-import-error').showModal();
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
  wireTips();
  wireDrawer();
  const tbody = $('#tbody');

  tbody.addEventListener('focusin', e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) select(tr.dataset.id);
  });
  tbody.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    select(id);
    if (e.target.closest('[data-act="toggle"]') && e.detail < 2) toggleCollapse(id);
    if (e.target.closest('[data-act="unpin"]')) {
      commit(plan => { plan.tasks.find(t => t.id === id).manualStart = null; });
    }
  });
  // Commit when a cell loses focus, after focus has landed on its new target
  tbody.addEventListener('focusout', e => {
    const input = e.target;
    if (!input.matches?.('input[data-f]') || input.readOnly) return;
    if (input.value === input.dataset.orig) return;
    const id = input.closest('tr').dataset.id;
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

  const dragOpts = {
    canDrop: (id, k) => canMove(id, planIndex(k)),
    onDrop: (id, k) => moveTask(id, planIndex(k)),
    enabled: () => !state.readOnly && state.plan.tasks.length > 1,
  };
  attachReorder($('#table-pane'), {
    ...dragOpts,
    grip: '.c-num',
    rows: () => [...document.querySelectorAll('#tbody tr[data-id]')].map(el => ({ id: el.dataset.id, el })),
  });
  attachReorder($('#gantt-pane'), {
    ...dragOpts,
    grip: '.g-row, .g-task, .g-row-bg',
    rows: () => [...document.querySelectorAll('#gantt-pane .g-row .g-row-bg')].map(el => ({ id: el.parentNode.dataset.id, el })),
  });

  $('#gantt-pane').addEventListener('click', e => {
    const el = e.target.closest('[data-id]');
    if (!el) return;
    select(el.dataset.id);
    if (e.target.closest('[data-act="toggle"]') && e.detail < 2) toggleCollapse(el.dataset.id);
  });
  // Double-clicking a summary row collapses or expands it (in either view);
  // on the triangle itself the first click already did that (the second is
  // ignored), so a double-click there toggles once, like a single click.
  const dblToggle = e => {
    if (e.target.closest('[data-act="toggle"]')) return true;
    const el = e.target.closest('[data-id]');
    if (!el || !state.sched.byId.get(el.dataset.id)?.summary) return false;
    toggleCollapse(el.dataset.id);
    window.getSelection()?.removeAllRanges(); // the double-click also selected a word
    return true;
  };
  tbody.addEventListener('dblclick', dblToggle);
  $('#pert-pane').addEventListener('click', e => {
    const el = e.target.closest('.pt-node');
    if (el) select(el.dataset.id);
  });
  // Double-click: a collapsed group expands (back to the full network);
  // a task opens in the table for editing.
  $('#pert-pane').addEventListener('dblclick', e => {
    const el = e.target.closest('.pt-node');
    if (!el || dblToggle(e)) return;
    if (state.readOnly) return;
    if (state.view === 'pert') { state.view = 'split-pert'; savePrefs(); render(); }
    document.querySelector(`#tbody tr[data-id="${el.dataset.id}"] input[data-f="name"]`)?.focus();
  });
  $('#gantt-pane').addEventListener('dblclick', e => {
    if (dblToggle(e)) return;
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
  $('#btn-sync').addEventListener('click', startSync);
  $('#sync-form').addEventListener('submit', e => {
    if (e.submitter?.value === 'sync') runSync(new FormData(e.target).get('message') || '');
  });
  $('#dlg-conflict').addEventListener('cancel', e => e.preventDefault()); // must choose
  for (const [id, side] of [['#btn-keep-mine', 'mine'], ['#btn-keep-theirs', 'theirs']]) {
    $(id).addEventListener('click', async () => {
      $('#dlg-conflict').close();
      try { await state.repo.resolveConflict(side); } catch (e) { toast(e.message, 'error'); }
    });
  }
  $('#btn-problem-reload').addEventListener('click', () => location.reload());
  $('#merge-body').addEventListener('change', () => { $('#btn-merge-finish').disabled = !mergeChoices().complete; });
  $('#btn-merge-finish').addEventListener('click', () => {
    const { choices, complete } = mergeChoices();
    if (!complete || !mergeState) return;
    $('#dlg-merge').close();
    completeMerge(mergeState, choices);
  });
  $('#btn-merge-cancel').addEventListener('click', () => $('#dlg-merge').close());
  $('#dlg-merge').addEventListener('close', () => {
    if (mergeState && !state.locked) {
      mergeState = null;
      toast('Nothing was merged. Your changes are safe; press Sync to try again.');
    }
  });
  $('#btn-export').addEventListener('click', () => {
    store.downloadText(`${store.safeFilename(state.plan.name)}.json`, store.planToJSON(state.plan));
  });
  // Open menu: each item sets the file picker's filter, then opens it
  for (const b of [$('#btn-import'), $('#btn-import-csv')]) {
    b.addEventListener('click', () => {
      $('#file-input').accept = b.dataset.kind === 'csv' ? '.csv,text/csv' : '.json,application/json';
      $('#file-input').click();
    });
  }
  wireMenu($('#btn-open-menu'), $('#open-menu'));
  $('#btn-csv-template').addEventListener('click', () => {
    store.downloadText('project-planner-template.csv', csvTemplate(), 'text/csv;charset=utf-8');
    $('#dlg-import-error').close();
  });
  $('#file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
  });
  $('#btn-share').addEventListener('click', showShare);
  $('#btn-csv').addEventListener('click', () => {
    store.downloadText(`${store.safeFilename(state.plan.name)}.csv`, planToCSV(state.plan, state.sched), 'text/csv;charset=utf-8');
  });
  wireMenu($('#btn-export-menu'), $('#export-menu'));
  $('#btn-print').addEventListener('click', printGantt);
  $('#btn-png').addEventListener('click', exportPNG);
  $('#btn-help').addEventListener('click', () => {
    const dlg = $('#dlg-help');
    dlg.showModal();
    dlg.scrollTop = 0; // showModal focuses Close at the bottom; start at the top
  });

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
      if (!confirm(`Delete “${p?.name ?? 'this plan'}” from this browser? This cannot be undone.\n\nTip: use Export → JSON file first if you want a backup.`)) return;
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
  PHONE.addEventListener('change', () => render()); // rotating across the breakpoint resizes the Gantt name column
  window.addEventListener('afterprint', () => {
    $('#print-area').innerHTML = '';
    delete document.documentElement.dataset.theme;
  });
}

async function loadFromHash() {
  if (state.repo || !location.hash.startsWith('#share=')) return false; // repo mode never shows other plans
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
  wireResizing();
  wireEvents();
  if (!store.storageAvailable()) {
    toast('Browser storage is unavailable (private mode?). Use Export → JSON file to keep your work.', 'error');
  }
  const token = repoToken();
  if (token) return initRepo(token);
  const repo = pageRepo();
  showRepoLink(repo);
  if (await loadFromHash()) return; // an explicit share link wins
  let bundle = null;
  try {
    bundle = await loadBundle(pageBundlePath());
  } catch (e) {
    toast(`${e.message} Showing the example planner instead.`, 'error');
  }
  if (bundle) return openViewer(bundle, repo);
  openPlan(loadInitialPlan());
}

init();
