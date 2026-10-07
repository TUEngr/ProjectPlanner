// Shared plans with turn-taking. A shared plan lives in a backend (the local
// test backend now, Firebase in phase 2). Anyone with access can view it and
// sees changes as they are saved; to change it you "Start editing", which
// takes the plan's lock, and "Done editing" releases it. Only the lock holder's
// saves are accepted, so two people can't edit at once.
//
// app.js owns the plan on screen; this module tells it when to show a plan,
// switch between viewing and editing, or take in someone else's changes,
// through the hooks passed to initCollab().

import { STORAGE_NS, FIREBASE_CONFIG, ALLOWED_DOMAIN } from './config.js';
import { LocalBackend } from './cloud/local.js';
import { lockStatus, HEARTBEAT_MS, IDLE_RELEASE_MS, LOCK_TTL_MS, canEdit, ROLES } from './cloud/lock.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const SAVE_DELAY_MS = 600;
// Test-only overrides (?idlems=, ?beatms=) so the idle timeout can be tested
// in seconds; they apply only with the local test backend.
const params = new URLSearchParams(location.search);
let IDLE_MS = IDLE_RELEASE_MS, BEAT_MS = HEARTBEAT_MS;

let hooks;           // from app.js
let backend;
const session = globalThis.crypto?.randomUUID?.() ?? `s${Date.now()}${Math.random()}`;
let cur = null;      // { id, meta, unsubscribe } for the open shared plan
let editing = false;
let dirty = false;
let saveTimer = 0, beatTimer = 0, tickTimer = 0;
let lastActivity = 0;
let saveState = '';  // shown in the banner while editing

export const isShared = () => !!cur;
export const isEditing = () => editing;
export const sharedRole = () => cur?.meta.role ?? null;
export const backendInfo = () => backend && { kind: backend.kind, label: backend.label };

export function initCollab(h) {
  hooks = h;
  // Phase 2 will construct a Firebase backend when FIREBASE_CONFIG is set
  backend = new LocalBackend(STORAGE_NS, ALLOWED_DOMAIN);
  if (backend.kind === 'local') {
    IDLE_MS = Number(params.get('idlems')) || IDLE_MS;
    BEAT_MS = Number(params.get('beatms')) || BEAT_MS;
  }
  if (FIREBASE_CONFIG) console.warn('Firebase is configured but not wired in yet (phase 2); using the local test backend.');
  wireUI();
  ['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, noteActivity, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', () => { if (editing) { flush(); backend.releaseLock(cur.id, session); } });
  window.addEventListener('beforeunload', e => { if (editing && dirty) { flush(); e.preventDefault(); e.returnValue = ''; } });
}

export function noteActivity() { lastActivity = Date.now(); }

// ---------- called by app.js ----------

// The plan changed (a commit, or a collapse/expand). Save soon if editing.
export function planChanged() {
  if (!editing) return;
  noteActivity();
  dirty = true;
  setSaveState('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

// Leaving the shared plan (opening a local plan, a file, a share link…)
export async function leave() {
  if (!cur) return;
  const c = cur;
  if (editing) { await flush(); await backend.releaseLock(c.id, session); }
  stopEditingTimers();
  editing = false;
  c.unsubscribe?.();
  cur = null;
  clearInterval(tickTimer);
  renderBanner();
}

// ---------- saving, heartbeat, idle ----------

async function flush() {
  clearTimeout(saveTimer);
  if (!cur || !editing || !dirty) return;
  dirty = false;
  const plan = hooks.getPlan();
  const res = await backend.savePlan(cur.id, plan, session).catch(e => ({ ok: false, reason: e.message }));
  if (res.ok) {
    cur.meta = res.meta;
    setSaveState(`Saved ${time(res.meta.updated)}`);
  } else {
    dirty = true;
    await lostLock(res);
  }
}

function stopEditingTimers() {
  clearTimeout(saveTimer);
  clearInterval(beatTimer);
}

async function beat() {
  if (!cur || !editing) return;
  if (Date.now() - lastActivity > IDLE_MS) {
    await flush();
    await stopEditing({ quiet: true });
    hooks.toast(`Editing ended after ${Math.round(IDLE_MS / 60000)} minutes without activity, so others can edit. Click Start editing to continue.`);
    return;
  }
  const res = await backend.heartbeat(cur.id, session).catch(e => ({ ok: false, reason: e.message }));
  if (!res.ok) await lostLock(res);
}

// Someone else holds the lock now (ours went stale and was taken over), or
// the plan is gone. Keep any unsaved work as a local copy, then show theirs.
async function lostLock(res) {
  const unsaved = dirty;
  stopEditingTimers();
  editing = false;
  dirty = false;
  if (unsaved) {
    const copy = hooks.keepLocalCopy(hooks.getPlan(), ' (unsaved changes)');
    hooks.toast(`You lost the editing lock${res.lock ? ` to ${res.lock.name}` : ''}. Your unsaved changes were kept as a separate plan in this browser: “${copy}”.`, 'error');
  } else {
    hooks.toast(`Editing ended: ${res.lock ? `${res.lock.name} is editing now` : 'the plan is no longer available'}.`, 'error');
  }
  if (res.reason === 'gone') return closeGone();
  try {
    const { plan, meta } = await backend.loadPlan(cur.id);
    cur.meta = meta;
    hooks.setEditing(false);
    hooks.applyRemote(plan);
  } catch { closeGone(); }
  renderBanner();
}

function closeGone() {
  cur?.unsubscribe?.();
  cur = null;
  editing = false;
  renderBanner();
  hooks.openLocal();
}

// ---------- opening, editing ----------

export async function openShared(id) {
  await leave();
  const { plan, meta } = await backend.loadPlan(id);
  cur = { id, meta };
  hooks.showShared(plan); // viewing until Start editing
  cur.unsubscribe = backend.subscribe(id, onRemote);
  clearInterval(tickTimer);
  tickTimer = setInterval(renderBanner, 15000); // a lock goes stale with time alone
  renderBanner();
}

function onRemote(data) {
  if (!cur) return;
  if (!data) {
    hooks.toast('This shared plan was deleted, or your access was removed.', 'error');
    return closeGone();
  }
  cur.meta = data.meta;
  if (editing) {
    if (data.meta.lock?.session !== session) lostLock({ reason: 'lost', lock: data.meta.lock });
  } else {
    hooks.applyRemote(data.plan);
  }
  renderBanner();
}

async function startEditing() {
  if (!cur || editing) return;
  const res = await backend.acquireLock(cur.id, session).catch(e => ({ ok: false, reason: e.message }));
  if (!res.ok) {
    hooks.toast(res.reason === 'held' ? `${res.lock.name} is editing this plan. You can edit when they finish.`
      : res.reason === 'role' ? 'You have view-only access to this plan.' : `Could not start editing: ${res.reason}`, 'error');
    return renderBanner();
  }
  // Start from the latest saved version
  const { plan, meta } = await backend.loadPlan(cur.id);
  cur.meta = meta;
  editing = true;
  dirty = false;
  noteActivity();
  hooks.applyRemote(plan);
  hooks.setEditing(true);
  setSaveState('No changes yet');
  beatTimer = setInterval(beat, BEAT_MS);
  renderBanner();
}

async function stopEditing({ quiet = false } = {}) {
  if (!cur || !editing) return;
  await flush();
  if (!editing) return; // flush found the lock lost
  stopEditingTimers();
  editing = false;
  await backend.releaseLock(cur.id, session);
  cur.meta.lock = null;
  hooks.setEditing(false);
  if (!quiet) hooks.toast('Done editing. Others can edit now.');
  renderBanner();
}

// ---------- banner (desktop) and chip + drawer (phones) ----------

function setSaveState(s) {
  saveState = s;
  const el = $('#cloud-save');
  if (el) el.textContent = s;
}

function renderBanner() {
  const b = $('#cloud-banner');
  const chip = $('#cloud-chip');
  b.hidden = chip.hidden = !cur;
  document.body.classList.toggle('shared', !!cur);
  if (!cur) return;
  const m = cur.meta;
  const st = lockStatus(m.lock, session);
  const may = canEdit(m.role);
  let msg, chipText;
  if (editing) {
    msg = `✏️ <strong>You are editing</strong> “${esc(m.name)}”. Others see your changes as they save. <span id="cloud-save" class="hint">${esc(saveState)}</span>`;
    chipText = '✏️ Editing';
  } else if (st === 'held') {
    msg = `🔒 <strong>${esc(m.lock.name)}</strong> is editing (since ${time(m.lock.since)}). You're viewing; their changes appear as they save.`;
    chipText = `🔒 ${m.lock.name.split(' ')[0]}`;
  } else if (st === 'stale') {
    msg = `${esc(m.lock.name)} started editing at ${time(m.lock.since)} but their session has gone quiet (no response for ${Math.round(LOCK_TTL_MS / 60000)}+ minutes). ${may ? 'You can take over.' : ''}`;
    chipText = '👁 Viewing';
  } else {
    msg = `👁 Viewing shared plan “${esc(m.name)}”${may ? '' : ' (view only)'}. Saved ${m.updated ? time(m.updated) : ''}${m.updatedBy ? ` by ${esc(m.updatedBy)}` : ''}.`;
    chipText = '👁 Viewing';
  }
  $('#cloud-msg').innerHTML = msg;
  chip.textContent = chipText;
  const edit = $('#btn-cloud-edit');
  edit.hidden = editing || !may;
  edit.disabled = st === 'held';
  edit.textContent = st === 'stale' ? 'Take over editing' : 'Start editing';
  $('#btn-cloud-done').hidden = !editing;
  $('#btn-cloud-members').hidden = m.role !== 'owner';
  $('#dr-cloud-msg').innerHTML = msg;
  hooks.syncDrawer?.();
}

// ---------- plans dialog section, sign-in, members ----------

export async function renderPlansSection() {
  const sec = $('#cloud-section');
  const user = backend.currentUser();
  const testNote = backend.kind === 'local' ? `<p class="hint cloud-test">${esc(backend.label)}.</p>` : '';
  if (!user) {
    sec.innerHTML = `<h3>Shared plans</h3>${testNote}
      <p>Sign in with your Trinity account to see plans shared with you and to share your own.</p>
      <button data-cloud="signin" class="primary">Sign in</button>`;
    return;
  }
  let list = [];
  try { list = await backend.listPlans(); } catch (e) { hooks.toast(e.message, 'error'); }
  const canShareCurrent = !isShared() && !hooks.isShareLinkView();
  sec.innerHTML = `<h3>Shared plans</h3>${testNote}
    <p class="hint">Signed in as <strong>${esc(user.email)}</strong> <button data-cloud="signout" class="textlink">Sign out</button></p>
    <ul class="plan-list">${list.length ? list.map(p => {
      const st = lockStatus(p.lock, session);
      const lock = st === 'held' ? `🔒 ${esc(p.lock.name)} editing` : st === 'mine' ? '✏️ you are editing' : st === 'stale' ? 'idle lock' : '';
      return `<li data-shared="${esc(p.id)}" class="${cur?.id === p.id ? 'current' : ''}">
        <button class="link" data-cloud="open">${esc(p.name)}</button>
        <span class="hint">${esc(p.role)}${lock ? ` · ${lock}` : ''}${cur?.id === p.id ? ' · open' : ''}</span>
        ${p.role === 'owner' ? '<button data-cloud="delete" class="danger" title="Delete this shared plan for everyone">Delete</button>' : ''}
      </li>`;
    }).join('') : '<li class="hint">No plans are shared with you yet.</li>'}</ul>
    ${canShareCurrent ? '<button data-cloud="share-current">Share the open plan…</button>' : ''}`;
}

function wireUI() {
  $('#cloud-section').addEventListener('click', async e => {
    const act = e.target.closest('[data-cloud]')?.dataset.cloud;
    if (!act) return;
    const id = e.target.closest('[data-shared]')?.dataset.shared;
    try {
      if (act === 'signin') return showSignIn();
      if (act === 'signout') { await leave(); await backend.signOut(); hooks.openLocal(); return renderPlansSection(); }
      if (act === 'open') { await openShared(id); $('#dlg-plans').close(); return; }
      if (act === 'delete') {
        if (!confirm('Delete this shared plan for everyone? This cannot be undone.')) return;
        if (cur?.id === id) { await leave(); hooks.openLocal(); }
        await backend.deletePlan(id);
        return renderPlansSection();
      }
      if (act === 'share-current') {
        const plan = hooks.getPlan();
        if (!confirm(`Share “${plan.name}”? A shared copy is made that you own; you can then give other Trinity people access. Your copy in this browser stays as it is.`)) return;
        const copy = { ...structuredClone(plan), id: hooks.newId() };
        await backend.createPlan(copy);
        await openShared(copy.id);
        $('#dlg-plans').close();
        showMembers();
      }
    } catch (err) { hooks.toast(err.message, 'error'); }
  });

  $('#signin-form').addEventListener('submit', async e => {
    if (e.submitter?.value !== 'signin') return;
    e.preventDefault();
    try {
      await backend.signIn($('#signin-email').value);
      $('#dlg-signin').close();
      renderPlansSection();
    } catch (err) { $('#signin-error').textContent = err.message; }
  });

  $('#btn-cloud-edit').addEventListener('click', startEditing);
  $('#btn-cloud-done').addEventListener('click', () => stopEditing());
  $('#btn-cloud-members').addEventListener('click', showMembers);
  $('#btn-cloud-close').addEventListener('click', async () => { await leave(); hooks.openLocal(); });

  $('#members-form').addEventListener('submit', async e => {
    if (e.submitter?.value !== 'add') return;
    e.preventDefault();
    try {
      cur.meta = await backend.setMember(cur.id, $('#member-email').value, $('#member-role').value);
      $('#member-email').value = '';
      renderMembers();
    } catch (err) { $('#members-error').textContent = err.message; }
  });
  $('#member-list').addEventListener('change', async e => {
    const sel = e.target.closest('select[data-email]');
    if (!sel) return;
    try {
      cur.meta = await backend.setMember(cur.id, sel.dataset.email, sel.value === 'remove' ? null : sel.value);
      renderMembers();
    } catch (err) { $('#members-error').textContent = err.message; }
  });
}

function showSignIn() {
  $('#signin-error').textContent = '';
  $('#signin-test').hidden = backend.kind !== 'local';
  $('#dlg-signin').showModal();
  $('#signin-email').focus();
}

function showMembers() {
  if (!cur || cur.meta.role !== 'owner') return;
  $('#members-error').textContent = '';
  renderMembers();
  $('#dlg-members').showModal();
}

function renderMembers() {
  const m = cur.meta;
  $('#members-plan').textContent = m.name;
  $('#member-list').innerHTML = Object.entries(m.members).sort((a, b) => ROLES.indexOf(a[1]) - ROLES.indexOf(b[1]) || a[0].localeCompare(b[0])).map(([email, role]) => `
    <li><span>${esc(email)}</span>${role === 'owner' ? '<span class="hint">owner</span>' : `
      <select data-email="${esc(email)}" aria-label="Access for ${esc(email)}">
        <option value="editor"${role === 'editor' ? ' selected' : ''}>can edit</option>
        <option value="viewer"${role === 'viewer' ? ' selected' : ''}>can view</option>
        <option value="remove">remove</option>
      </select>`}</li>`).join('');
}

// Test hook (local backend only)
export const _test = { backend: () => backend, session };
