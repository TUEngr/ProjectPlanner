// Tests for task ids and the repo file format (js/planfiles.js).
import { normalize, newTaskId, TASK_ID_RE, blankTask } from '../js/storage.js';
import { samplePlan } from '../js/sample.js';
import { schedule } from '../js/schedule.js';
import { rankBetween, assignRanks, planToFiles, planFromFiles, PLAN_FILE, TASK_DIR } from '../js/planfiles.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push([true, name]); }
  catch (e) { results.push([false, `${name}: ${e.message}`]); }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

// Deterministic pseudo-random numbers so a failure reproduces.
function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ ...blankTask(`t${i + 1}`), name: `task ${i + 1}`, ...extra }));
const strictlyIncreasing = tasks => tasks.every((t, i) => i === 0 || tasks[i - 1].rank < t.rank);
const diffPaths = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort();

test('new task ids are unique, file-safe, and not row numbers', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) { const id = newTaskId({ tasks: [] }); ok(TASK_ID_RE.test(id), id); seen.add(id); }
  ok(seen.size > 495, `only ${seen.size} unique of 500`);
  ok(newTaskId({ tasks: [{ id: 'x' }] }) !== 'x', 'collided with existing');
});

test('rankBetween: 3000 random inserts stay strictly ordered with no trailing zero', () => {
  const next = rng(7);
  const list = [];
  for (let i = 0; i < 3000; i++) {
    const at = Math.floor(next() * (list.length + 1));
    const r = rankBetween(list[at - 1] ?? '', list[at] ?? null);
    ok(/^[0-9a-z]*[1-9a-z]$/.test(r), `bad rank ${r}`);
    list.splice(at, 0, r);
  }
  for (let i = 1; i < list.length; i++) ok(list[i - 1] < list[i], `${list[i - 1]} !< ${list[i]} at ${i}`);
});

test('rankBetween: repeated inserts at the end and at the front stay short enough', () => {
  let tail = '', head = 'i';
  for (let i = 0; i < 200; i++) tail = rankBetween(tail, null);
  for (let i = 0; i < 200; i++) head = rankBetween('', head);
  ok(tail.length < 60 && head.length < 260, `tail ${tail.length}, head ${head.length}`);
  let threw = false;
  try { rankBetween('b', 'a'); } catch { threw = true; }
  ok(threw, 'out-of-order bounds should throw');
});

test('assignRanks: initial ranks are increasing, valid, and leave room to insert', () => {
  for (const n of [1, 2, 16, 300, 2000]) {
    const t = mk(n);
    eq(assignRanks(t), n);
    ok(strictlyIncreasing(t), `n=${n} not increasing`);
    ok(t.every(x => /^[0-9a-z]*[1-9a-z]$/.test(x.rank)), `n=${n} invalid rank`);
  }
  const t = mk(16); assignRanks(t);
  ok(t[1].rank.length <= 2, 'initial ranks should be short');
});

test('assignRanks: is idempotent', () => {
  const t = mk(20); assignRanks(t);
  eq(assignRanks(t), 0);
});

test('assignRanks: moving one task up or down changes only that task', () => {
  const t = mk(20); assignRanks(t);
  const before = Object.fromEntries(t.map(x => [x.id, x.rank]));
  const [moved] = t.splice(15, 1); t.splice(3, 0, moved); // up
  eq(assignRanks(t), 1);
  ok(strictlyIncreasing(t), 'not ordered after move up');
  const [m2] = t.splice(3, 1); t.splice(18, 0, m2); // down
  eq(assignRanks(t), 1);
  ok(strictlyIncreasing(t), 'not ordered after move down');
  eq(t.filter(x => x.rank !== before[x.id]).map(x => x.id), [moved.id]);
});

test('assignRanks: a newly inserted task gets a rank between its neighbours', () => {
  const t = mk(10); assignRanks(t);
  const before = t.map(x => x.rank);
  t.splice(5, 0, { ...blankTask('new'), rank: null });
  eq(assignRanks(t), 1);
  ok(strictlyIncreasing(t), 'not ordered');
  eq(t.filter(x => x.id !== 'new').map(x => x.rank), before);
});

test('files: sample plan round-trips byte-for-byte', () => {
  const plan = samplePlan();
  const a = planToFiles(plan);
  const back = planFromFiles(a);
  const b = planToFiles(back);
  eq(Object.keys(a).length, 1 + plan.tasks.length);
  eq(diffPaths(a, b), []);
  eq(back.tasks.map(t => [t.id, t.name, t.level, t.duration, t.preds]), plan.tasks.map(t => [t.id, t.name, t.level, t.duration, t.preds]));
  eq(back.name, plan.name);
  eq(back.id, plan.id);
  ok(Object.keys(a).every(k => k === PLAN_FILE || k.startsWith(TASK_DIR)), 'unexpected path');
});

test('files: a round-tripped plan schedules identically', () => {
  const plan = samplePlan();
  const back = planFromFiles(planToFiles(plan));
  const strip = s => s.rows.map(r => [r.id, r.es, r.ef, r.critical, r.float]);
  eq(strip(schedule(back)), strip(schedule(plan)));
});

test('files: output is deterministic and carries no per-user or time data', () => {
  const plan = samplePlan();
  plan.updated = '2026-01-01T00:00:00Z';
  plan.tasks[2].collapsed = true;
  const a = planToFiles(plan);
  plan.updated = '2027-01-01T00:00:00Z';
  plan.tasks[2].collapsed = false;
  eq(diffPaths(a, planToFiles(plan)), []);
  const text = Object.values(a).join('');
  ok(!/collapsed|updated|nextId/.test(text), 'per-user/time fields leaked into files');
  ok(Object.values(a).every(s => s.endsWith('}\n')), 'missing trailing newline');
});

test('files: editing one task changes exactly one file', () => {
  const plan = samplePlan();
  const a = planToFiles(plan);
  plan.tasks[4].name = 'Renamed';
  plan.tasks[4].duration = 9;
  eq(diffPaths(a, planToFiles(plan)), [`${TASK_DIR}${plan.tasks[4].id}.json`]);
});

test('files: adding, deleting and moving tasks touch only the files involved', () => {
  const plan = samplePlan();
  const a = planToFiles(plan);
  const added = { ...blankTask(newTaskId(plan)), name: 'added' };
  plan.tasks.splice(6, 0, added);
  eq(diffPaths(a, planToFiles(plan)), [`${TASK_DIR}${added.id}.json`]);
  const b = planToFiles(plan);
  const [moved] = plan.tasks.splice(10, 1); plan.tasks.splice(1, 0, moved);
  eq(diffPaths(b, planToFiles(plan)), [`${TASK_DIR}${moved.id}.json`]);
});

test('files: two people adding at the same spot get distinct files and a stable order', () => {
  const base = samplePlan();
  const files = planToFiles(base);
  const a = planFromFiles(files), b = planFromFiles(files);
  const ta = { ...blankTask('aaaa'), name: 'from A' }, tb = { ...blankTask('bbbb'), name: 'from B' };
  a.tasks.splice(5, 0, ta); b.tasks.splice(5, 0, tb);
  const fa = planToFiles(a), fb = planToFiles(b);
  eq(ta.rank, tb.rank, 'same slot should pick the same rank (the realistic conflict case)');
  const merged = planFromFiles({ ...fa, ...fb }); // what git produces when the files differ
  eq(merged.tasks.length, base.tasks.length + 2);
  eq(merged.tasks.slice(5, 7).map(t => t.name), ['from A', 'from B']);
  const files2 = planToFiles(merged);
  ok(strictlyIncreasing(merged.tasks), 'ranks are unique again after saving');
  eq(planFromFiles(files2).tasks.map(t => t.id), merged.tasks.map(t => t.id));
});

test('files: bad input fails with the file name and a merge-conflict hint', () => {
  const files = planToFiles(samplePlan());
  const bad = Object.keys(files).find(k => k.startsWith(TASK_DIR));
  let msg = '';
  try { planFromFiles({ ...files, [bad]: '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n' }); } catch (e) { msg = e.message; }
  ok(msg.includes(bad) && /conflict/i.test(msg), msg);
  msg = '';
  try { planFromFiles({}); } catch (e) { msg = e.message; }
  ok(msg.includes(PLAN_FILE), msg);
  msg = '';
  try { planFromFiles({ ...files, [PLAN_FILE]: '{nope' }); } catch (e) { msg = e.message; }
  ok(msg.includes(PLAN_FILE), msg);
});

test('files: unrelated or unsafe paths are ignored, and the file name is the task id', () => {
  const files = planToFiles(samplePlan());
  const n = Object.keys(files).length - 1;
  const extra = {
    'data/tasks/../evil.json': '{"name":"x"}', 'data/tasks/UPPER.json': '{"name":"x"}',
    'data/tasks/sub/dir.json': '{"name":"x"}', 'data/notes.txt': 'hi',
  };
  eq(planFromFiles({ ...files, ...extra }).tasks.length, n);
  const first = Object.keys(files).find(k => k.startsWith(TASK_DIR));
  const lied = { ...files, [first]: files[first].replace(/"id": "[a-z0-9]+"/, '"id": "other"') };
  ok(planFromFiles(lied).tasks.some(t => `${TASK_DIR}${t.id}.json` === first), 'file name should win over the id inside');
});

test('migration: integer ids and predecessors become t<n>, identically for everyone', () => {
  const old = { id: 'p1', name: 'old', start: '2026-10-05', nextId: 4, tasks: [
    { id: 1, name: 'a', duration: 2, preds: [] },
    { id: 2, name: 'b', duration: 3, preds: [1] },
    { id: 3, name: 'c', duration: 1, preds: [{ id: 2, type: 'SS' }, { id: 1, type: 'FS' }] },
  ] };
  const a = planToFiles(normalize(old)), b = planToFiles(normalize(JSON.parse(JSON.stringify(old))));
  eq(diffPaths(a, b), []);
  const p = planFromFiles(a);
  eq(p.tasks.map(t => t.id), ['t1', 't2', 't3']);
  eq(p.tasks[2].preds, [{ id: 't2', type: 'SS' }, { id: 't1', type: 'FS' }]);
  ok(!('nextId' in p), 'nextId should be gone');
});

test('migration: duplicate or invalid ids are repaired and links stay valid', () => {
  const p = normalize({ start: '2026-10-05', tasks: [
    { id: 1, name: 'a', duration: 1 }, { id: 1, name: 'dup', duration: 1 }, { id: 'Bad Id!', name: 'bad', duration: 1 }, { name: 'none', duration: 1, preds: [1] },
  ] });
  const ids = p.tasks.map(t => t.id);
  eq(new Set(ids).size, 4);
  ok(ids.every(id => TASK_ID_RE.test(id)), ids.join());
  eq(p.tasks[3].preds, [{ id: 't1', type: 'FS' }]);
});

test('scheduler works with string ids and with legacy integer ids', () => {
  const s = schedule(samplePlan());
  ok(s.rows.length === 16 && s.rows[1].id === 't2', 'string ids');
  const legacy = schedule({ name: 'x', start: '2026-10-05', holidays: [], tasks: [
    { id: 1, name: 'a', level: 0, duration: 2, preds: [], manualStart: null, pct: 0 },
    { id: 2, name: 'b', level: 0, duration: 2, preds: [1], manualStart: null, pct: 0 },
  ] });
  eq(legacy.byId.get(2).es, 2);
});

export default results;
