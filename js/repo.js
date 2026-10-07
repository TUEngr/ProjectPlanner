// Repo mode: the plan lives in data/ of this git clone, reached through the
// local helper (server/serve.py). Nothing here touches the DOM, so it can be
// tested against a fake API.
//
//   RepoApi      thin fetch wrapper (token from the page, errors made readable)
//   RepoSession  keeps memory and disk in step: debounced saves, merging when
//                the disk changed underneath (git pull, another tab), and sync

import { planToFiles, planFromFiles, sameFiles, mergeFiles } from './planfiles.js';

export class RepoError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// The helper injects a per-launch token into the page it serves. No token
// means this is a plain static page (e.g. GitHub Pages): use browser storage.
export function repoToken() {
  return globalThis.document?.querySelector('meta[name="pp-token"]')?.content || null;
}

export class RepoApi {
  constructor(token, fetchFn = (...a) => fetch(...a)) {
    this.token = token;
    this.fetch = fetchFn;
  }

  async call(method, path, body) {
    let res;
    try {
      res = await this.fetch(path, {
        method, cache: 'no-store',
        headers: { 'X-PP-Token': this.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new RepoError('offline', 'Cannot reach the Project Planner helper. If this is a Codespace, it may have stopped: reopen it and reload this page.');
    }
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    if (res.status === 403) throw new RepoError('auth', 'The helper was restarted or this page is out of date. Reload the page.');
    return { status: res.status, body: json };
  }

  async plan() {
    const { status, body } = await this.call('GET', '/api/plan');
    if (status !== 200) throw new RepoError('error', body?.error || `Could not read the plan (${status}).`);
    return body; // { exists, rev, files }
  }

  // -> { ok: true, rev, written } | { stale: true, rev }
  async put(files, baseRev) {
    const { status, body } = await this.call('PUT', '/api/plan', { baseRev, files });
    if (status === 200) return { ok: true, ...body };
    if (status === 409) return { stale: true, rev: body.rev };
    throw new RepoError('error', body?.error || `Could not save (${status}).`);
  }

  // fetch=false skips contacting GitHub (cheap; ahead/behind may be stale)
  async status(fetch = true) {
    const { status, body } = await this.call('GET', '/api/git/status' + (fetch ? '' : '?fetch=0'));
    if (status !== 200) throw new RepoError('error', body?.error || `Could not read git status (${status}).`);
    return body;
  }

  // -> { ok: true, status } | { conflict: true, files } | { error }
  async sync(message) {
    const { status, body } = await this.call('POST', '/api/git/sync', { message });
    if (status === 200) return { ok: true, status: body };
    if (status === 409) return { conflict: true, files: body.files || [] };
    return { error: [body?.error, body?.detail].filter(Boolean).join(': ') || `Sync failed (${status}).` };
  }
}

export class RepoSession {
  // getPlan(): the plan in memory. adopt(plan): the plan changed under the user
  // (merge, pull); the app should show it. onState(): state or conflict changed.
  // setTimer / clearTimer are injectable so tests need no real clock.
  constructor(api, { getPlan, adopt, onState = () => {}, delay = 400, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
    this.api = api;
    this.getPlan = getPlan;
    this.adopt = adopt;
    this.onState = onState;
    this.delay = delay;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.rev = null;
    this.base = {};          // files as of the last read or write of the disk
    this.state = 'saved';    // 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
    this.error = null;
    this.conflict = null;    // { mine, theirs, paths } while state === 'conflict'
    this._timer = null;
    this._saving = null;
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.onState(state);
  }

  // Read the plan from disk. Returns null when the repo has no plan yet.
  async load() {
    const snap = await this.api.plan();
    this.rev = snap.rev;
    this.base = snap.files;
    this._set('saved');
    return snap.exists ? planFromFiles(snap.files) : null;
  }

  // Write a brand-new plan into an empty repo.
  async create(plan) {
    const files = planToFiles(plan);
    const r = await this.api.put(files, this.rev);
    if (!r.ok) throw new RepoError('error', 'The repository changed while creating the plan. Reload the page.');
    this.rev = r.rev;
    this.base = files;
    this._set('saved');
  }

  // The plan in memory changed: save soon.
  markDirty() {
    if (this.state === 'conflict') return;
    this.clearTimer(this._timer);
    this._set('dirty');
    this._timer = this.setTimer(() => this.flush().catch(() => {}), this.delay);
  }

  // Save now. Resolves when disk matches memory, or the session needs the user.
  flush() {
    this.clearTimer(this._timer);
    if (this.state === 'conflict') return Promise.resolve(this.state);
    if (!this._saving) {
      // Deferred a tick so `_saving` is set before any re-entrant flush() can look.
      this._saving = Promise.resolve().then(() => this._save()).finally(() => { this._saving = null; });
    }
    return this._saving;
  }

  async _save() {
    this._set('saving');
    try {
      for (;;) {
        const files = planToFiles(this.getPlan());
        if (sameFiles(files, this.base)) { this._set('saved'); return 'saved'; }
        const r = await this.api.put(files, this.rev);
        if (r.ok) { this.rev = r.rev; this.base = files; continue; } // re-check: more edits may have arrived
        const outcome = await this._reconcile(files);
        if (outcome === 'conflict') return outcome;
      }
    } catch (e) {
      this._set('error', e.message);
      throw e;
    }
  }

  // The disk is not what we last saw. Merge our edits onto it.
  async _reconcile(mine, prefer = null) {
    const latest = await this.api.plan();
    const merged = mergeFiles(this.base, mine, latest.files, prefer);
    if (merged.conflicts.length && !prefer) {
      this.conflict = { mine, theirs: latest.files, paths: merged.conflicts };
      this._set('conflict');
      return 'conflict';
    }
    this.base = latest.files;
    this.rev = latest.rev;
    this.adopt(planFromFiles(merged.files)); // shows what others changed; our edits stay in it
    return 'merged';
  }

  // The user chose a side for the files both changed.
  async resolveConflict(prefer) {
    if (this.state !== 'conflict') return;
    const { mine } = this.conflict;
    this.conflict = null;
    this._set('saving');
    try {
      await this._reconcile(mine, prefer);
    } catch (e) {
      this._set('error', e.message);
      throw e;
    }
    await this.flush();
  }

  // Take whatever is on disk now, if we have no unsaved edits. Returns true if the plan changed.
  async refresh() {
    if (this.state !== 'saved') return false;
    const latest = await this.api.plan();
    if (latest.rev === this.rev) return false;
    this.rev = latest.rev;
    this.base = latest.files;
    if (latest.exists) this.adopt(planFromFiles(latest.files));
    return true;
  }

  // Save, then commit + pull + push, then show whatever was pulled.
  // -> { status: 'ok', git } | { status: 'conflict', files } | { status: 'error', message } | { status: 'blocked' }
  async sync(message) {
    await this.flush();
    if (this.state !== 'saved') return { status: 'blocked' };
    const r = await this.api.sync(message);
    if (r.conflict) return { status: 'conflict', files: r.files };
    if (r.error) return { status: 'error', message: r.error };
    const latest = await this.api.plan(); // the pull may have changed files
    if (latest.rev !== this.rev) {
      this.rev = latest.rev;
      this.base = latest.files;
      if (latest.exists) this.adopt(planFromFiles(latest.files));
    }
    return { status: 'ok', git: r.status };
  }
}
