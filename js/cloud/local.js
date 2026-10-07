// Local test backend for shared plans. Implements the same interface the
// Firebase backend will (phase 2), but keeps shared plans in this browser's
// localStorage, so two tabs or windows signed in as different people behave
// like two computers: one edits while the other watches the changes arrive.
//
// Changes are atomic across tabs (Web Locks API), and other tabs are told
// about them through the browser's `storage` event.
//
// Record in localStorage at `${ns}.cloud.${id}`:
//   { meta: { id, name, owner, members: {email: role}, version, updated, updatedBy, lock },
//     plan }

import { lockStatus, canTakeLock, newLock, canEdit, emailAllowed } from './lock.js';

const nameFromEmail = email => email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

export class LocalBackend {
  constructor(ns, domain) {
    this.ns = ns;
    this.domain = domain;
    this.kind = 'local';
    this.label = 'Test mode: shared plans live in this browser and are shared between its tabs and windows';
    this.needsEmail = true; // sign-in asks for an address (Firebase uses Google sign-in)
    this.userKey = `${ns}.cloud.user`;
    this.prefix = `${ns}.cloud.plan.`;
    // ?testuser=a@trinity.edu signs this window in as that person, held in
    // memory: frames on one page share sessionStorage, so tests that put two
    // "people" in two frames can't use it.
    const param = new URLSearchParams(location.search).get('testuser');
    this.forced = param && emailAllowed(param, domain) ? this._user(param) : null;
  }

  // ---- identity (per tab, so two tabs can be two people) ----
  _user(email) {
    return { email: email.trim().toLowerCase(), name: nameFromEmail(email.trim()) };
  }
  currentUser() {
    if (this.forced) return this.forced;
    try {
      const u = JSON.parse(sessionStorage.getItem(this.userKey) || 'null');
      return u?.email ? u : null;
    } catch { return null; }
  }
  _setUser(email) {
    const user = this._user(email);
    try { sessionStorage.setItem(this.userKey, JSON.stringify(user)); } catch { /* private mode */ }
    return user;
  }
  async signIn(email) {
    if (!emailAllowed(email, this.domain)) throw new Error(`Use your @${this.domain} address.`);
    return this._setUser(email);
  }
  async signOut() {
    this.forced = null;
    try { sessionStorage.removeItem(this.userKey); } catch { /* ignore */ }
  }

  // ---- storage helpers ----
  _read(id) {
    try { return JSON.parse(localStorage.getItem(this.prefix + id) || 'null'); } catch { return null; }
  }
  _write(id, rec) {
    localStorage.setItem(this.prefix + id, JSON.stringify(rec));
  }
  // Read-modify-write one record atomically across tabs
  async _update(id, fn) {
    const run = async () => {
      const rec = this._read(id);
      const out = await fn(rec);
      if (out?.write) this._write(id, out.write);
      return out?.result;
    };
    return navigator.locks?.request ? navigator.locks.request(`${this.prefix}${id}`, run) : run();
  }
  _me() {
    const u = this.currentUser();
    if (!u) throw new Error('Sign in first.');
    return u;
  }
  _role(meta, email) {
    return meta?.members?.[email] || null;
  }

  // ---- plans ----
  async listPlans() {
    const me = this._me();
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(this.prefix)) continue;
      const rec = this._read(k.slice(this.prefix.length));
      const role = this._role(rec?.meta, me.email);
      if (role) out.push({ ...rec.meta, role });
    }
    return out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  async createPlan(plan) {
    const me = this._me();
    const id = plan.id;
    const meta = { id, name: plan.name, owner: me.email, members: { [me.email]: 'owner' }, version: 1, updated: Date.now(), updatedBy: me.email, lock: null };
    this._write(id, { meta, plan });
    return { ...meta, role: 'owner' };
  }

  async loadPlan(id) {
    const me = this._me();
    const rec = this._read(id);
    if (!rec) throw new Error('That shared plan no longer exists.');
    const role = this._role(rec.meta, me.email);
    if (!role) throw new Error('You don’t have access to that plan.');
    return { plan: rec.plan, meta: { ...rec.meta, role } };
  }

  // cb({ plan, meta }) whenever another tab changes the plan; cb(null) if deleted
  subscribe(id, cb) {
    const key = this.prefix + id;
    const onStorage = e => {
      if (e.key !== key) return;
      const me = this.currentUser();
      const rec = e.newValue ? JSON.parse(e.newValue) : null;
      if (!rec || !me || !this._role(rec.meta, me.email)) return cb(null);
      cb({ plan: rec.plan, meta: { ...rec.meta, role: this._role(rec.meta, me.email) } });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }

  // ---- lock ----
  async acquireLock(id, session) {
    const me = this._me();
    return this._update(id, rec => {
      if (!rec) return { result: { ok: false, reason: 'gone' } };
      const role = this._role(rec.meta, me.email);
      if (!canEdit(role)) return { result: { ok: false, reason: 'role' } };
      if (!canTakeLock(lockStatus(rec.meta.lock, session))) return { result: { ok: false, reason: 'held', lock: rec.meta.lock } };
      rec.meta.lock = newLock(session, me);
      return { write: rec, result: { ok: true, meta: { ...rec.meta, role } } };
    });
  }

  async heartbeat(id, session) {
    return this._update(id, rec => {
      if (!rec || rec.meta.lock?.session !== session) return { result: { ok: false, reason: rec ? 'lost' : 'gone' } };
      rec.meta.lock.heartbeat = Date.now();
      return { write: rec, result: { ok: true } };
    });
  }

  async releaseLock(id, session) {
    return this._update(id, rec => {
      if (!rec || rec.meta.lock?.session !== session) return { result: { ok: true } };
      rec.meta.lock = null;
      return { write: rec, result: { ok: true } };
    });
  }

  // Saves only while this session holds the lock
  async savePlan(id, plan, session) {
    const me = this._me();
    return this._update(id, rec => {
      if (!rec) return { result: { ok: false, reason: 'gone' } };
      if (rec.meta.lock?.session !== session) return { result: { ok: false, reason: 'lost', lock: rec.meta.lock } };
      rec.plan = plan;
      rec.meta.name = plan.name;
      rec.meta.version += 1;
      rec.meta.updated = Date.now();
      rec.meta.updatedBy = me.email;
      rec.meta.lock.heartbeat = Date.now();
      return { write: rec, result: { ok: true, meta: { ...rec.meta, role: this._role(rec.meta, me.email) } } };
    });
  }

  // ---- members (owner only) ----
  async setMember(id, email, role) {
    const me = this._me();
    if (!emailAllowed(email, this.domain)) throw new Error(`Only @${this.domain} addresses can be added.`);
    const who = email.trim().toLowerCase();
    return this._update(id, rec => {
      if (!rec) throw new Error('That shared plan no longer exists.');
      if (rec.meta.owner !== me.email) throw new Error('Only the plan’s owner can change who has access.');
      if (who === rec.meta.owner) throw new Error('The owner’s access can’t be changed.');
      if (role) rec.meta.members[who] = role; else delete rec.meta.members[who];
      if (!role && rec.meta.lock?.email === who) rec.meta.lock = null;
      return { write: rec, result: { ...rec.meta, role: 'owner' } };
    });
  }

  async deletePlan(id) {
    const me = this._me();
    const rec = this._read(id);
    if (!rec) return;
    if (rec.meta.owner !== me.email) throw new Error('Only the plan’s owner can delete it.');
    localStorage.removeItem(this.prefix + id);
  }

  // Test hook: make a lock look abandoned
  _ageLock(id, ms) {
    const rec = this._read(id);
    if (rec?.meta.lock) { rec.meta.lock.heartbeat -= ms; this._write(id, rec); }
  }
}
