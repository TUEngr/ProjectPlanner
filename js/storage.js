// Persistence: plans live in this browser's localStorage; JSON files move them
// between machines; share links carry a compressed read-only copy in the URL
// fragment (never sent to any server).

import { parseISO, toISO, todayDay, dayOfWeek } from './calendar.js';
import { linksOf } from './schedule.js';

const INDEX_KEY = 'projectplanner.index';
const PLAN_PREFIX = 'projectplanner.plan.';
const LAST_KEY = 'projectplanner.last';
export const FORMAT_VERSION = 1;

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function lsRemove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function storageAvailable() {
  return lsSet('projectplanner.probe', '1') && (lsRemove('projectplanner.probe'), true);
}

export function listPlans() {
  try {
    const list = JSON.parse(lsGet(INDEX_KEY) || '[]');
    return Array.isArray(list) ? list.sort((a, b) => (b.updated || '').localeCompare(a.updated || '')) : [];
  } catch { return []; }
}

export function loadPlan(id) {
  try {
    const raw = lsGet(PLAN_PREFIX + id);
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch { return null; }
}

export function savePlan(plan) {
  plan.updated = new Date().toISOString();
  const ok = lsSet(PLAN_PREFIX + plan.id, JSON.stringify(plan));
  if (!ok) return false;
  const list = listPlans().filter(p => p.id !== plan.id);
  list.push({ id: plan.id, name: plan.name, updated: plan.updated });
  lsSet(INDEX_KEY, JSON.stringify(list));
  lsSet(LAST_KEY, plan.id);
  return true;
}

export function deletePlan(id) {
  lsRemove(PLAN_PREFIX + id);
  lsSet(INDEX_KEY, JSON.stringify(listPlans().filter(p => p.id !== id)));
  if (lsGet(LAST_KEY) === id) lsRemove(LAST_KEY);
}

export function lastPlanId() {
  return lsGet(LAST_KEY);
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function nextMonday() {
  let n = todayDay();
  while (dayOfWeek(n) !== 1) n++;
  return toISO(n);
}

export function blankTask(id) {
  return { id, name: '', level: 0, duration: 1, preds: [], manualStart: null, pct: 0, assignee: '', notes: '' };
}

export function newPlan(name = 'Untitled project') {
  return {
    format: FORMAT_VERSION, id: uid(), name, start: nextMonday(), holidays: [], satOff: true, sunOff: true,
    tasks: [{ ...blankTask(1), name: 'First task', duration: 5 }],
    nextId: 2,
  };
}

// Validate and fill defaults for a plan from storage, a file, or a share link.
// Throws with a readable message if the data is not a plan.
export function normalize(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.tasks)) {
    throw new Error('This file is not a Project Planner plan (no task list).');
  }
  const start = parseISO(obj.start) !== null ? obj.start : nextMonday();
  const ids = new Set();
  const tasks = obj.tasks.map((t, i) => {
    let id = Number.isInteger(t.id) && t.id > 0 && !ids.has(t.id) ? t.id : null;
    if (id === null) id = -(i + 1); // fixed below
    ids.add(id);
    return {
      id,
      name: String(t.name ?? ''),
      level: Math.max(0, Math.min(20, Number(t.level) | 0)),
      duration: Math.max(0, Math.round(Number(t.duration) || 0)),
      preds: Array.isArray(t.preds) ? linksOf(t) : [], // bare ids from older plans become FS links
      manualStart: t.manualStart && parseISO(t.manualStart) !== null ? t.manualStart : null,
      collapsed: t.collapsed === true,
      pct: Math.max(0, Math.min(100, Math.round(Number(t.pct) || 0))),
      assignee: String(t.assignee ?? ''),
      notes: String(t.notes ?? ''),
    };
  });
  let next = Math.max(0, ...tasks.map(t => t.id)) + 1;
  for (const t of tasks) if (t.id < 0) t.id = next++;
  fixLevels(tasks);
  return {
    format: FORMAT_VERSION,
    id: typeof obj.id === 'string' && obj.id ? obj.id : uid(),
    name: String(obj.name || 'Untitled project'),
    start,
    holidays: Array.isArray(obj.holidays)
      ? obj.holidays.filter(h => h && parseISO(h.date) !== null).map(h => ({ date: h.date, label: String(h.label ?? '') }))
      : [],
    satOff: obj.satOff !== false, // older plans: weekends off
    sunOff: obj.sunOff !== false,
    tasks,
    nextId: Math.max(next, Number(obj.nextId) || 0),
    updated: obj.updated,
  };
}

// Each row may be at most one level deeper than the row above it.
export function fixLevels(tasks) {
  let prev = -1;
  for (const t of tasks) {
    t.level = Math.max(0, Math.min(t.level, prev + 1));
    prev = t.level;
  }
}

// ---- JSON files ----

export function planToJSON(plan) {
  return JSON.stringify(plan, null, 2);
}

export function downloadText(filename, text, type = 'application/json') {
  downloadBlob(filename, new Blob([text], { type }));
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name) {
  return (name || 'plan').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'plan';
}

// ---- Share links ----

const SHARE_PREFIX = 'share=';

export async function encodeShare(plan) {
  const { id, updated, ...rest } = plan; // a shared copy gets a new id when saved
  const bytes = new TextEncoder().encode(JSON.stringify(rest));
  const compressed = await streamBytes(bytes, new CompressionStream('deflate-raw'));
  return SHARE_PREFIX + toBase64Url(compressed);
}

export async function decodeShare(hash) {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith(SHARE_PREFIX)) return null;
  const bytes = fromBase64Url(h.slice(SHARE_PREFIX.length));
  const raw = await streamBytes(bytes, new DecompressionStream('deflate-raw'));
  return normalize(JSON.parse(new TextDecoder().decode(raw)));
}

async function streamBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
