// Field-level merge (js/merge.js).
import { analyze, finish, LABELS } from '../js/merge.js';
import { serializeFile, planToFiles, PLAN_FILE, TASK_DIR } from '../js/planfiles.js';
import { samplePlan } from '../js/sample.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push([true, name]); } catch (e) { results.push([false, `${name}: ${e.message}`]); }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

const T = (over = {}) => ({ id: 't1', rank: 'i', name: 'Build', level: 0, duration: 3, preds: [], manualStart: null, pct: 0, assignee: '', notes: '', ...over });
const text = obj => serializeFile(`${TASK_DIR}t1.json`, obj);
const P = `${TASK_DIR}t1.json`;
const run = (base, ours, theirs, path = P) => analyze(path, { base: base && text(base), ours: ours && text(ours), theirs: theirs && text(theirs) });
const merged = (a, choices = {}) => JSON.parse(finish(a, choices));

test('merge: different fields of the same task merge without asking', () => {
  const a = run(T(), T({ name: 'Build v2' }), T({ duration: 8, assignee: 'Sam' }));
  eq(a.conflicts, []);
  eq(a.auto, 3);
  const m = merged(a);
  eq([m.name, m.duration, m.assignee], ['Build v2', 8, 'Sam']);
});

test('merge: git-adjacent fields (name next to level) merge without asking', () => {
  const a = run(T(), T({ name: 'New name' }), T({ level: 1 }));
  eq(a.conflicts, []);
  eq([merged(a).name, merged(a).level], ['New name', 1]);
});

test('merge: the same change on both sides is not a conflict', () => {
  const a = run(T(), T({ pct: 50 }), T({ pct: 50 }));
  eq([a.conflicts.length, merged(a).pct], [0, 50]);
});

test('merge: the same field changed differently asks, with a label, and either choice works', () => {
  const a = run(T(), T({ name: 'Mine' }), T({ name: 'Theirs' }));
  eq(a.conflicts.map(c => [c.id, c.label, c.ours, c.theirs]), [['name', 'Name', 'Mine', 'Theirs']]);
  eq(merged(a, { name: 'ours' }).name, 'Mine');
  eq(merged(a, { name: 'theirs' }).name, 'Theirs');
  eq(merged(a).name, 'Mine', 'unchosen defaults to ours');
});

test('merge: a choice applies only to its own field', () => {
  const a = run(T(), T({ name: 'Mine', notes: 'my note' }), T({ name: 'Theirs', notes: 'their note', duration: 9 }));
  eq(a.conflicts.map(c => c.id), ['name', 'notes']);
  const m = merged(a, { name: 'theirs', notes: 'ours' });
  eq([m.name, m.notes, m.duration], ['Theirs', 'my note', 9]);
});

test('merge: predecessors added on both sides are both kept, mine first', () => {
  const a = run(T(), T({ preds: [{ id: 'x', type: 'FS' }] }), T({ preds: [{ id: 'y', type: 'SS' }] }));
  eq(a.conflicts, []);
  eq(merged(a).preds, [{ id: 'x', type: 'FS' }, { id: 'y', type: 'SS' }]);
});

test('merge: predecessor order as typed is preserved, additions from the other side follow', () => {
  const base = T({ preds: [{ id: 'b', type: 'FS' }, { id: 'a', type: 'FS' }] });
  const a = run(base, base, T({ preds: [{ id: 'b', type: 'FS' }, { id: 'a', type: 'FS' }, { id: 'c', type: 'FF' }] }));
  eq(merged(a).preds.map(l => l.id), ['b', 'a', 'c']);
});

test('merge: removing one predecessor while the other side adds another keeps both effects', () => {
  const base = T({ preds: [{ id: 'x', type: 'FS' }] });
  const a = run(base, T({ preds: [] }), T({ preds: [{ id: 'x', type: 'FS' }, { id: 'y', type: 'FS' }] }));
  eq(a.conflicts, []);
  eq(merged(a).preds, [{ id: 'y', type: 'FS' }]);
});

test('merge: the same predecessor changed two ways is a conflict on that predecessor only', () => {
  const base = T({ preds: [{ id: 'x', type: 'FS' }, { id: 'z', type: 'FS' }] });
  const a = run(base,
    T({ preds: [{ id: 'x', type: 'SS' }, { id: 'z', type: 'FS' }] }),
    T({ preds: [{ id: 'x', type: 'FF' }, { id: 'z', type: 'FS' }, { id: 'n', type: 'FS' }] }));
  eq(a.conflicts.map(c => [c.id, c.ours?.type, c.theirs?.type]), [['preds:x', 'SS', 'FF']]);
  eq(merged(a, { 'preds:x': 'theirs' }).preds, [{ id: 'x', type: 'FF' }, { id: 'z', type: 'FS' }, { id: 'n', type: 'FS' }]);
  eq(merged(a, { 'preds:x': 'ours' }).preds[0], { id: 'x', type: 'SS' });
});

test('merge: removed on one side but changed on the other is a conflict, either way', () => {
  const base = T({ preds: [{ id: 'x', type: 'FS' }] });
  const a = run(base, T({ preds: [] }), T({ preds: [{ id: 'x', type: 'SS' }] }));
  eq(a.conflicts.map(c => [c.id, c.ours ?? null, c.theirs?.type]), [['preds:x', null, 'SS']]);
  eq(merged(a, { 'preds:x': 'ours' }).preds, []);
  eq(merged(a, { 'preds:x': 'theirs' }).preds, [{ id: 'x', type: 'SS' }]);
});

test('merge: both moved the task to different places is one clear conflict', () => {
  const a = run(T(), T({ rank: 'c' }), T({ rank: 'x' }));
  eq(a.conflicts.map(c => [c.id, c.label]), [['rank', 'Position in the list']]);
});

test('merge: delete vs edit asks; delete vs unchanged just deletes', () => {
  const edited = run(T(), null, T({ name: 'edited' }));
  eq(edited.conflicts.map(c => [c.id, c.ours, c.theirs?.name]), [['*', null, 'edited']]);
  eq(finish(edited, { '*': 'ours' }), null);
  eq(JSON.parse(finish(edited, { '*': 'theirs' })).name, 'edited');
  const clean = run(T(), T(), null);
  eq([clean.conflicts.length, finish(clean)], [0, null]);
  eq(finish(run(T(), null, null)), null);
});

test('merge: the plan settings merge too, holidays by date', () => {
  const base = { id: 'p', name: 'Plan', start: '2026-10-05', satOff: true, sunOff: true, showGantt: true, showPert: true, holidays: [{ date: '2026-11-26', label: 'Thanksgiving' }] };
  const pt = obj => serializeFile(PLAN_FILE, obj);
  const a = analyze(PLAN_FILE, {
    base: pt(base),
    ours: pt({ ...base, name: 'Mine', holidays: [...base.holidays, { date: '2026-12-25', label: 'Xmas' }] }),
    theirs: pt({ ...base, start: '2026-10-12', holidays: [...base.holidays, { date: '2027-01-01', label: 'New Year' }] }),
  });
  eq(a.conflicts, []);
  const m = JSON.parse(finish(a));
  eq([m.name, m.start, m.holidays.map(h => h.date)], ['Mine', '2026-10-12', ['2026-11-26', '2026-12-25', '2027-01-01']]);
  const b = analyze(PLAN_FILE, { base: pt(base), ours: pt({ ...base, holidays: [{ date: '2026-11-26', label: 'Mine' }] }), theirs: pt({ ...base, holidays: [{ date: '2026-11-26', label: 'Theirs' }] }) });
  eq(b.conflicts.map(c => [c.id, c.label]), [['holidays:2026-11-26', 'Holiday']]);
});

test('merge: the near-critical threshold merges like any other plan setting', () => {
  const base = { id: 'p', name: 'Plan', start: '2026-10-05', satOff: true, sunOff: true, showGantt: true, showPert: true, nearCritical: 2, holidays: [] };
  const pt = obj => serializeFile(PLAN_FILE, obj);
  const only = analyze(PLAN_FILE, { base: pt(base), ours: pt({ ...base, nearCritical: 5 }), theirs: pt(base) });
  eq([only.conflicts.length, JSON.parse(finish(only)).nearCritical], [0, 5]);
  const both = analyze(PLAN_FILE, { base: pt(base), ours: pt({ ...base, nearCritical: 5 }), theirs: pt({ ...base, nearCritical: 0 }) });
  eq(both.conflicts.map(c => [c.id, c.label]), [['nearCritical', 'Near-critical threshold (days)']]);
  eq(JSON.parse(finish(both, { nearCritical: 'theirs' })).nearCritical, 0);
});

test('merge: two people creating plan.json in an empty project agree on the plan id and ask only about real differences', () => {
  const mk = (id, name) => serializeFile(PLAN_FILE, { id, name, start: '2026-10-05', satOff: true, sunOff: true, showGantt: true, showPert: true, holidays: [] });
  const a = analyze(PLAN_FILE, { base: null, ours: mk('bbbb', 'From B'), theirs: mk('aaaa', 'From A') });
  const swapped = analyze(PLAN_FILE, { base: null, ours: mk('aaaa', 'From A'), theirs: mk('bbbb', 'From B') });
  eq(a.conflicts.map(c => c.id), ['name']);
  eq(JSON.parse(finish(a)).id, 'aaaa');
  eq(JSON.parse(finish(swapped)).id, 'aaaa', 'same id whichever side is ours');
  const same = analyze(PLAN_FILE, { base: null, ours: mk('bbbb', 'Same'), theirs: mk('aaaa', 'Same') });
  eq(same.conflicts, []);
});

test('merge: invalid or non-object JSON is reported as raw, never merged', () => {
  for (const bad of ['not json', '[1,2]', '5', '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n']) {
    eq(analyze(P, { base: text(T()), ours: bad, theirs: text(T()) }).kind, 'raw', bad);
  }
});

test('merge: output is the canonical text (what planToFiles writes), so identical sides give identical bytes', () => {
  const plan = samplePlan();
  const files = planToFiles(plan);
  const path = Object.keys(files).find(k => k.startsWith(TASK_DIR));
  const a = analyze(path, { base: files[path], ours: files[path], theirs: files[path] });
  eq(finish(a), files[path]);
  const p = analyze(PLAN_FILE, { base: files[PLAN_FILE], ours: files[PLAN_FILE], theirs: files[PLAN_FILE] });
  eq(finish(p), files[PLAN_FILE]);
});

test('merge: each analysis has a readable title', () => {
  eq(run(T(), T({ name: 'Mine' }), T()).title, 'Mine');
  eq(run(T(), null, T({ name: 'Theirs' })).title, 'Theirs');
  eq(run(T({ name: '' }), T({ name: '' }), T({ name: '' })).title, 't1');
  eq(analyze(PLAN_FILE, { base: null, ours: '{}', theirs: '{}' }).title, 'Plan settings');
  eq(analyze(P, { base: null, ours: 'junk', theirs: null }).title, 't1');
});

test('merge: every field has a label', () => {
  for (const f of ['rank', 'name', 'level', 'duration', 'manualStart', 'pct', 'assignee', 'notes', 'preds', 'start', 'satOff', 'sunOff', 'showGantt', 'showPert', 'holidays']) ok(LABELS[f], f);
});

// ---- property test: random edits on both sides ----
function randomEdit(next, t) {
  const o = { ...t, preds: t.preds.map(l => ({ ...l })) };
  const k = Math.floor(next() * 8);
  if (k === 0) o.name = 'n' + Math.floor(next() * 3);
  if (k === 1) o.duration = Math.floor(next() * 4);
  if (k === 2) o.pct = Math.floor(next() * 3) * 25;
  if (k === 3) o.assignee = ['', 'A', 'B'][Math.floor(next() * 3)];
  if (k === 4) o.notes = 'x' + Math.floor(next() * 2);
  if (k === 5) o.rank = ['c', 'i', 'r'][Math.floor(next() * 3)];
  if (k === 6) { const id = ['p', 'q', 'r'][Math.floor(next() * 3)]; const i = o.preds.findIndex(l => l.id === id); if (i >= 0) o.preds.splice(i, 1); else o.preds.push({ id, type: ['FS', 'SS'][Math.floor(next() * 2)] }); }
  if (k === 7) { const l = o.preds[0]; if (l) l.type = ['FS', 'SS', 'FF'][Math.floor(next() * 3)]; }
  return o;
}

test('merge property: 1500 random edit pairs never lose a value and do not depend on which side is “ours”', () => {
  const next = rng(2024);
  let conflicted = 0;
  for (let i = 0; i < 1500; i++) {
    const base = T({ preds: next() < 0.5 ? [{ id: 'p', type: 'FS' }] : [] });
    let o = base, t = base;
    for (let n = Math.floor(next() * 3); n >= 0; n--) o = randomEdit(next, o);
    for (let n = Math.floor(next() * 3); n >= 0; n--) t = randomEdit(next, t);
    const a = run(base, o, t), b = run(base, t, o);
    eq(a.conflicts.map(c => c.id), b.conflicts.map(c => c.id), `case ${i} conflict ids`);
    if (a.conflicts.length) conflicted++;
    // resolving every conflict the same way (all ours / all theirs) must pick from the two sides only
    for (const side of ['ours', 'theirs']) {
      const choices = Object.fromEntries(a.conflicts.map(c => [c.id, side]));
      const m = merged(a, choices);
      for (const f of ['name', 'duration', 'pct', 'assignee', 'notes', 'rank']) {
        ok([o[f], t[f]].some(v => v === m[f]), `case ${i}: ${f}=${m[f]} came from neither side`);
      }
      for (const l of m.preds) ok([...o.preds, ...t.preds].some(x => x.id === l.id && x.type === l.type), `case ${i}: invented predecessor ${JSON.stringify(l)}`);
    }
    if (!a.conflicts.length) {
      const ma = merged(a), mb = merged(b);
      eq(ma.preds.map(l => l.id).sort(), mb.preds.map(l => l.id).sort(), `case ${i} preds commute`);
      for (const f of ['name', 'duration', 'pct', 'assignee', 'notes', 'rank']) eq(ma[f], mb[f], `case ${i} ${f} commutes`);
    }
    // a side that changed nothing never overrides the other
    const onlyMine = run(base, o, base);
    eq(onlyMine.conflicts, [], `case ${i} one-sided`);
    for (const f of ['name', 'duration', 'pct', 'assignee', 'notes', 'rank']) eq(merged(onlyMine)[f], o[f], `case ${i} one-sided ${f}`);
  }
  ok(conflicted > 100 && conflicted < 1400, `property test is not exercising both paths (${conflicted} conflicted of 1500)`);
});

export default results;
