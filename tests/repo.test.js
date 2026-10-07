// Tests for repo mode: file-level merge and RepoSession, against a fake helper.
import { samplePlan } from '../js/sample.js';
import { blankTask, newTaskId } from '../js/storage.js';
import { planToFiles, planFromFiles, mergeFiles, sameFiles, PLAN_FILE, TASK_DIR } from '../js/planfiles.js';
import { RepoApi, RepoSession, RepoError } from '../js/repo.js';

const results = [];
let chain = Promise.resolve(); // tests run one after another, in order
function test(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); results.push([true, name]); }
    catch (e) { results.push([false, `${name}: ${e.message}`]); }
  });
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

// A stand-in for server/serve.py's plan API: same stale-revision rule.
class FakeApi {
  constructor(files = {}) { this.files = { ...files }; this.n = 0; this.puts = []; this.syncs = []; this.down = false; this.syncResult = null; }
  rev() { return `r${this.n}`; }
  async plan() { if (this.down) throw new RepoError('offline', 'down'); return { exists: PLAN_FILE in this.files, rev: this.rev(), files: { ...this.files } }; }
  async put(files, baseRev) {
    if (this.down) throw new RepoError('offline', 'down');
    if (baseRev !== this.rev()) return { stale: true, rev: this.rev() };
    const written = Object.keys(files).filter(k => this.files[k] !== files[k]);
    this.files = { ...files }; this.n++; this.puts.push(written);
    return { ok: true, rev: this.rev(), written };
  }
  // Someone else (a pull, another tab) changes the disk.
  external(mutator) { const f = { ...this.files }; mutator(f); this.files = f; this.n++; }
  async conflicts() { return this.conflictData; }
  async resolve(req) {
    this.resolveCalls = (this.resolveCalls || []).concat([req]);
    if (this.resolveResult) return this.resolveResult;
    const f = { ...this.files };
    for (const [p, t] of Object.entries(req.files)) { if (t === null) delete f[p]; else f[p] = t; }
    this.files = f; this.n++;
    return { ok: true, status: { ahead: 0, behind: 0 } };
  }
  async sync(message) { this.syncs.push({ message, filesAtSync: { ...this.files } }); return this.syncResult || { ok: true, status: { ahead: 0, behind: 0 } }; }
}

function setup(files) {
  const api = new FakeApi(files);
  const env = { plan: null, adopted: [], states: [], timers: [] };
  const session = new RepoSession(api, {
    getPlan: () => env.plan,
    adopt: p => { env.plan = p; env.adopted.push(p); },
    onState: s => env.states.push(s),
    setTimer: (fn) => { env.timers.push(fn); return env.timers.length; },
    clearTimer: id => { if (id) env.timers[id - 1] = null; },
  });
  // Fire pending timers like a real clock would: without waiting for what they start.
  env.fireTimers = () => { const t = env.timers.filter(Boolean); env.timers = []; t.forEach(fn => { fn(); }); };
  env.runTimers = async () => { const t = env.timers.filter(Boolean); env.timers = []; for (const fn of t) await fn(); };
  return { api, env, session };
}
async function started(plan = samplePlan()) {
  const files = planToFiles(plan);
  const s = setup(files);
  s.env.plan = await s.session.load();
  return s;
}
const taskFile = (plan, i) => `${TASK_DIR}${plan.tasks[i].id}.json`;

// ---- mergeFiles ----

test('mergeFiles: a change on one side wins, an identical change on both is fine', () => {
  const base = { a: '1', b: '1', c: '1', d: '1' };
  const mine = { a: '2', b: '1', c: '3', d: '1' };
  const theirs = { a: '2', b: '9', c: '1', d: '1' };
  const r = mergeFiles(base, { ...mine, [PLAN_FILE]: 'p' }, { ...theirs, [PLAN_FILE]: 'p' });
  eq(r.conflicts, []);
  eq([r.files.a, r.files.b, r.files.c, r.files.d], ['2', '9', '3', '1']);
});

test('mergeFiles: additions and deletions on different sides combine', () => {
  const base = { [PLAN_FILE]: 'p', x: '1', y: '1' };
  const r = mergeFiles(base, { [PLAN_FILE]: 'p', x: '1', y: '1', mineNew: 'm' }, { [PLAN_FILE]: 'p', y: '1', theirNew: 't' });
  eq(r.conflicts, []);
  eq(Object.keys(r.files).sort(), [PLAN_FILE, 'mineNew', 'theirNew', 'y']);
});

test('mergeFiles: both changed differently is a conflict, resolved by prefer; delete vs edit counts', () => {
  const base = { [PLAN_FILE]: 'p', x: '1', y: '1' };
  const mine = { [PLAN_FILE]: 'p', x: 'mine', y: 'mine' };
  const theirs = { [PLAN_FILE]: 'p', x: 'theirs' }; // y deleted by them
  const r = mergeFiles(base, mine, theirs);
  eq(r.conflicts, ['x', 'y']);
  eq([mergeFiles(base, mine, theirs, 'mine').files.x, mergeFiles(base, mine, theirs, 'mine').files.y], ['mine', 'mine']);
  const t = mergeFiles(base, mine, theirs, 'theirs');
  eq([t.files.x, 'y' in t.files], ['theirs', false]);
});

test('mergeFiles: plan.json is never lost', () => {
  const r = mergeFiles({ [PLAN_FILE]: 'p' }, { [PLAN_FILE]: 'a' }, {}, 'theirs');
  eq(r.files[PLAN_FILE], 'a');
});

test('planFromFiles drops links to tasks that no longer exist', () => {
  const plan = samplePlan();
  const files = planToFiles(plan);
  delete files[taskFile(plan, 1)]; // someone deleted row 2; row 3 still links to it
  const back = planFromFiles(files);
  ok(back.tasks.every(t => t.preds.every(l => back.tasks.some(x => x.id === l.id))), 'dangling link kept');
  ok(!back.tasks.some(t => t.id === plan.tasks[1].id), 'task should be gone');
});

// ---- RepoSession ----

test('session: an empty repo loads as null, then create() writes the plan', async () => {
  const { api, session } = setup({});
  eq(await session.load(), null);
  const plan = samplePlan();
  await session.create(plan);
  eq(Object.keys(api.files).length, 1 + plan.tasks.length);
  const s2 = setup(api.files);
  eq((await s2.session.load()).tasks.length, plan.tasks.length);
});

test('session: edits are debounced into one save that writes only the changed file', async () => {
  const { api, env, session } = await started();
  env.plan.tasks[3].name = 'a';
  session.markDirty();
  env.plan.tasks[3].name = 'ab';
  session.markDirty();
  env.plan.tasks[3].name = 'abc';
  session.markDirty();
  eq(api.puts.length, 0, 'nothing written before the timer');
  await env.runTimers();
  eq(api.puts.length, 1);
  eq(api.puts[0], [taskFile(env.plan, 3)]);
  eq(session.state, 'saved');
  ok(api.files[taskFile(env.plan, 3)].includes('"abc"'), 'latest text saved');
});

test('session: a save that changes nothing on disk makes no request', async () => {
  const { api, env, session } = await started();
  env.plan.tasks[2].collapsed = true; // per-user view state is not stored
  session.markDirty();
  await env.runTimers();
  eq(api.puts.length, 0);
  eq(session.state, 'saved');
});

test('session: edits made while a save is in flight are not lost, even if the debounce timer fires mid-request', async () => {
  const { api, env, session } = await started();
  const origPut = api.put.bind(api);
  let first = true;
  api.put = async (files, rev) => {
    if (first) {
      first = false;
      env.plan.tasks[5].name = 'edited during flight';
      session.markDirty();
      env.fireTimers(); // slow request: the timer's flush() joins the save already in progress
    }
    return origPut(files, rev);
  };
  env.plan.tasks[1].name = 'first edit';
  session.markDirty();
  await session.flush();
  eq(session.state, 'saved');
  ok(api.files[taskFile(env.plan, 1)].includes('first edit'), 'first edit');
  ok(api.files[taskFile(env.plan, 5)].includes('edited during flight'), 'edit during flight');
});

test('session: disk changed under us (different task) merges both and shows theirs', async () => {
  const { api, env, session } = await started();
  const theirId = env.plan.tasks[8].id;
  api.external(f => { f[`${TASK_DIR}${theirId}.json`] = f[`${TASK_DIR}${theirId}.json`].replace(/"name": "[^"]*"/, '"name": "THEIRS"'); });
  env.plan.tasks[2].name = 'MINE';
  session.markDirty();
  await env.runTimers();
  eq(session.state, 'saved');
  eq(env.adopted.length, 1);
  eq([env.plan.tasks[8].name, env.plan.tasks[2].name], ['THEIRS', 'MINE']);
  const disk = planFromFiles(api.files);
  eq([disk.tasks[8].name, disk.tasks[2].name], ['THEIRS', 'MINE']);
});

test('session: the same task changed on both sides asks first and writes nothing', async () => {
  const { api, env, session } = await started();
  const path = taskFile(env.plan, 4), id = env.plan.tasks[4].id;
  api.external(f => { f[path] = f[path].replace(/"name": "[^"]*"/, '"name": "THEIRS"'); });
  env.plan.tasks[4].name = 'MINE';
  env.plan.tasks[7].name = 'MINE too';
  session.markDirty();
  await env.runTimers();
  eq(session.state, 'conflict');
  eq(session.conflict.paths, [path]);
  ok(api.files[path].includes('THEIRS'), 'disk untouched');
  eq(api.puts.length, 0);
  // choose mine: my version of the clash, plus my other edit
  await session.resolveConflict('mine');
  eq(session.state, 'saved');
  const disk = planFromFiles(api.files);
  eq([disk.tasks.find(t => t.id === id).name, disk.tasks[7].name], ['MINE', 'MINE too']);
});

test('session: choosing theirs keeps their version of the clash but still saves my other edits', async () => {
  const { api, env, session } = await started();
  const path = taskFile(env.plan, 4), id = env.plan.tasks[4].id;
  api.external(f => { f[path] = f[path].replace(/"name": "[^"]*"/, '"name": "THEIRS"'); });
  env.plan.tasks[4].name = 'MINE';
  env.plan.tasks[7].name = 'MINE too';
  session.markDirty();
  await env.runTimers();
  await session.resolveConflict('theirs');
  const disk = planFromFiles(api.files);
  eq([disk.tasks.find(t => t.id === id).name, disk.tasks[7].name], ['THEIRS', 'MINE too']);
  eq(env.plan.tasks.find(t => t.id === id).name, 'THEIRS');
});

test('session: a task deleted by someone else while I edited another is merged cleanly', async () => {
  const { api, env, session } = await started();
  const goneId = env.plan.tasks[10].id;
  api.external(f => { delete f[`${TASK_DIR}${goneId}.json`]; });
  env.plan.tasks[2].duration = 9;
  session.markDirty();
  await env.runTimers();
  eq(session.state, 'saved');
  ok(!env.plan.tasks.some(t => t.id === goneId), 'deleted task is gone from memory');
  ok(!(`${TASK_DIR}${goneId}.json` in api.files), 'and from disk');
  eq(env.plan.tasks.find(t => t.name === env.plan.tasks[2].name).duration, 9);
});

test('session: two people insert at the same spot, both tasks survive in a stable order', async () => {
  const { api, env, session } = await started();
  const other = planFromFiles(api.files);
  const theirs = { ...blankTask('theirnew'), name: 'theirs' };
  other.tasks.splice(5, 0, theirs);
  const theirFiles = planToFiles(other);
  api.external(f => { Object.assign(f, theirFiles); });
  env.plan.tasks.splice(5, 0, { ...blankTask(newTaskId(env.plan)), name: 'mine' });
  session.markDirty();
  await env.runTimers();
  eq(session.state, 'saved');
  const disk = planFromFiles(api.files);
  eq(disk.tasks.length, samplePlan().tasks.length + 2);
  eq(disk.tasks.slice(5, 7).map(t => t.name).sort(), ['mine', 'theirs']);
  ok(planToFiles(planFromFiles(api.files)) && sameFiles(planToFiles(planFromFiles(api.files)), api.files), 'stable on reload');
});

test('session: refresh adopts disk changes only when there is nothing unsaved', async () => {
  const { api, env, session } = await started();
  const id = env.plan.tasks[6].id, path = `${TASK_DIR}${id}.json`;
  api.external(f => { f[path] = f[path].replace(/"name": "[^"]*"/, '"name": "PULLED"'); });
  eq(await session.refresh(), true);
  eq(env.plan.tasks[6].name, 'PULLED');
  eq(await session.refresh(), false, 'unchanged disk');
  env.plan.tasks[1].name = 'typing';
  session.markDirty();
  api.external(f => { f[path] = f[path].replace(/"name": "[^"]*"/, '"name": "AGAIN"'); });
  eq(await session.refresh(), false, 'dirty: left to the save/merge path');
  eq(env.plan.tasks[6].name, 'PULLED');
});

test('session: sync saves first, passes the message, then shows what was pulled', async () => {
  const { api, env, session } = await started();
  const id = env.plan.tasks[9].id, path = `${TASK_DIR}${id}.json`;
  env.plan.tasks[2].name = 'my edit';
  session.markDirty();
  const origSync = api.sync.bind(api);
  api.sync = async m => { const r = await origSync(m); api.external(f => { f[path] = f[path].replace(/"name": "[^"]*"/, '"name": "FROM PULL"'); }); return r; };
  const r = await session.sync('Update plan');
  eq(r.status, 'ok');
  ok(api.syncs[0].filesAtSync[taskFile(env.plan, 2)].includes('my edit'), 'edit was on disk before the commit');
  eq(api.syncs[0].message, 'Update plan');
  eq(env.plan.tasks[9].name, 'FROM PULL');
  eq(session.state, 'saved');
});

test('session: sync passes through git conflicts and errors, and refuses when blocked', async () => {
  const { api, session } = await started();
  api.syncResult = { conflict: true, files: ['data/tasks/x.json'] };
  eq(await session.sync('m'), { status: 'conflict', files: ['data/tasks/x.json'] });
  api.syncResult = { error: 'push failed: nope' };
  eq(await session.sync('m'), { status: 'error', message: 'push failed: nope' });
  session.state = 'conflict';
  eq((await session.sync('m')).status, 'blocked');
});

test('session: if the helper is unreachable the state is error, and the next save recovers', async () => {
  const { api, env, session } = await started();
  env.plan.tasks[1].name = 'offline edit';
  session.markDirty();
  api.down = true;
  let threw = false;
  try { await session.flush(); } catch (e) { threw = e.kind === 'offline'; }
  ok(threw, 'flush should reject with an offline error');
  eq(session.state, 'error');
  api.down = false;
  await session.flush();
  eq(session.state, 'saved');
  ok(api.files[taskFile(env.plan, 1)].includes('offline edit'), 'edit saved after recovery');
});

// ---- conflict resolution through the session ----

const taskText = (plan, i, over = {}) => { const t = { ...plan.tasks[i], ...over }; return planToFiles({ ...plan, tasks: [t] })[`${TASK_DIR}${t.id}.json`]; };

test('session: beginMerge sorts conflicts into those it can ask about and those it cannot', async () => {
  const plan = samplePlan(); const path = taskFile(plan, 2);
  const { api, session } = await started(plan);
  api.conflictData = { ours: 'a'.repeat(40), theirs: 'b'.repeat(40), entries: {
    [path]: { base: taskText(plan, 2), ours: taskText(plan, 2, { name: 'Mine' }), theirs: taskText(plan, 2, { name: 'Theirs', duration: 9 }) },
    'js/code.js': { base: 'x', ours: 'y', theirs: 'z' },
    [taskFile(plan, 3)]: { base: taskText(plan, 3), ours: 'not json', theirs: taskText(plan, 3) },
  } };
  const m = await session.beginMerge();
  eq(m.items.map(a => a.path), [path]);
  eq(m.items[0].conflicts.map(c => c.id), ['name']);
  eq(m.items[0].auto, 1, 'their duration change merges without asking');
  eq(m.unresolvable.sort(), ['js/code.js', taskFile(plan, 3)].sort());
});

test('session: finishMerge sends one resolved file per conflict, with each file’s own choices, and shows the result', async () => {
  const plan = samplePlan(); const p1 = taskFile(plan, 2), p2 = taskFile(plan, 5);
  const { api, env, session } = await started(plan);
  api.conflictData = { ours: 'a'.repeat(40), theirs: 'b'.repeat(40), entries: {
    [p1]: { base: taskText(plan, 2), ours: taskText(plan, 2, { name: 'P1 mine' }), theirs: taskText(plan, 2, { name: 'P1 theirs', duration: 9 }) },
    [p2]: { base: taskText(plan, 5), ours: taskText(plan, 5, { name: 'P2 mine' }), theirs: taskText(plan, 5, { name: 'P2 theirs' }) },
  } };
  const m = await session.beginMerge();
  const r = await session.finishMerge(m, { [p1]: { name: 'theirs' }, [p2]: { name: 'ours' } }, 'Merge it');
  eq(r.status, 'ok');
  const req = api.resolveCalls[0];
  eq([req.ours, req.theirs, req.message], ['a'.repeat(40), 'b'.repeat(40), 'Merge it']);
  eq(Object.keys(req.files).sort(), [p1, p2].sort());
  const disk = planFromFiles(api.files);
  eq([disk.tasks[2].name, disk.tasks[2].duration, disk.tasks[5].name], ['P1 theirs', 9, 'P2 mine']);
  eq([env.plan.tasks[2].name, session.state], ['P1 theirs', 'saved']);
});

test('session: a deleted-vs-edited task resolves to null (delete) or the edited text', async () => {
  const plan = samplePlan(); const path = taskFile(plan, 4);
  const { api, env, session } = await started(plan);
  api.conflictData = { ours: 'a'.repeat(40), theirs: 'b'.repeat(40), entries: { [path]: { base: taskText(plan, 4), ours: null, theirs: taskText(plan, 4, { name: 'edited' }) } } };
  const m = await session.beginMerge();
  eq(m.items[0].conflicts.map(c => c.id), ['*']);
  await session.finishMerge(m, { [path]: { '*': 'ours' } });
  eq(api.resolveCalls[0].files[path], null);
  ok(!env.plan.tasks.some(t => t.id === plan.tasks[4].id), 'deleted task gone from the page');
});

test('session: finishMerge reports a moved remote and errors without touching the page', async () => {
  const plan = samplePlan(); const path = taskFile(plan, 2);
  const { api, env, session } = await started(plan);
  api.conflictData = { ours: 'a'.repeat(40), theirs: 'b'.repeat(40), entries: { [path]: { base: taskText(plan, 2), ours: taskText(plan, 2, { name: 'm' }), theirs: taskText(plan, 2, { name: 't' }) } } };
  const m = await session.beginMerge();
  const before = JSON.stringify(env.plan);
  api.resolveResult = { changed: true };
  eq(await session.finishMerge(m, {}), { status: 'changed' });
  api.resolveResult = { error: 'push failed: denied' };
  eq(await session.finishMerge(m, {}), { status: 'error', message: 'push failed: denied' });
  eq(JSON.stringify(env.plan), before);
});

test('api: conflicts and resolve map their responses', async () => {
  eq(await new RepoApi('t', fakeFetch(200, { ours: 'a', theirs: 'b', entries: {} })).conflicts(), { ours: 'a', theirs: 'b', entries: {} });
  eq(await new RepoApi('t', fakeFetch(409, { error: 'changed' })).resolve({}), { changed: true });
  eq(await new RepoApi('t', fakeFetch(409, { error: 'resolution does not match the conflicts' })).resolve({}), { error: 'resolution does not match the conflicts' });
  eq(await new RepoApi('t', fakeFetch(502, { error: 'push failed', detail: 'no' })).resolve({}), { error: 'push failed: no' });
  eq((await new RepoApi('t', fakeFetch(200, { ahead: 0 })).resolve({})).ok, true);
  let threw = false;
  try { await new RepoApi('t', fakeFetch(400, { error: 'no upstream' })).conflicts(); } catch { threw = true; }
  ok(threw, 'conflicts() should throw on an error response');
});

// ---- RepoApi ----

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => { calls.push([url, init]); return { status, json: async () => body }; };
  fn.calls = calls;
  return fn;
}

test('api: sends the token and a JSON body; maps 409 to stale and 403 to an auth error', async () => {
  const f = fakeFetch(409, { error: 'stale', rev: 'r9' });
  const api = new RepoApi('tok', f);
  eq(await api.put({ a: '1' }, 'r1'), { stale: true, rev: 'r9' });
  const [url, init] = f.calls[0];
  eq([url, init.method, init.headers['X-PP-Token']], ['/api/plan', 'PUT', 'tok']);
  eq(JSON.parse(init.body), { baseRev: 'r1', files: { a: '1' } });
  let kind = '';
  try { await new RepoApi('tok', fakeFetch(403, {})).plan(); } catch (e) { kind = e.kind; }
  eq(kind, 'auth');
});

test('api: a network failure becomes a readable offline error; sync maps conflict and error', async () => {
  let kind = '', msg = '';
  try { await new RepoApi('t', async () => { throw new TypeError('x'); }).plan(); } catch (e) { kind = e.kind; msg = e.message; }
  eq(kind, 'offline');
  ok(/Codespace/.test(msg), msg);
  eq(await new RepoApi('t', fakeFetch(409, { error: 'merge conflict', files: ['a'] })).sync('m'), { conflict: true, files: ['a'] });
  eq(await new RepoApi('t', fakeFetch(502, { error: 'push failed', detail: 'denied' })).sync('m'), { error: 'push failed: denied' });
});

export const ready = chain;
export default results;
