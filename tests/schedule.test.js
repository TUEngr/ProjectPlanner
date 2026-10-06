// Scheduler unit tests. Run with macOS's built-in JavaScriptCore:
//   ./tests/run.sh
// or open tests/index.html in a browser.

import { Calendar, parseISO, toISO } from '../js/calendar.js';
import { schedule, durationBetween, linkDrives, hiddenIds, linksOf } from '../js/schedule.js';
import { parsePredList, formatLink } from '../js/table.js';
import { normalize } from '../js/storage.js';
import { planToCSV, parseCSV, csvToPlan, csvTemplate, csvDate } from '../js/csv.js';
import { samplePlan } from '../js/sample.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push([true, name]); }
  catch (e) { results.push([false, `${name}: ${e.message}`]); }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}

let nextId = 1;
const T = (name, duration, preds = [], extra = {}) =>
  ({ id: nextId++, name, level: 0, duration, preds, manualStart: null, pct: 0, ...extra });
const plan = (tasks, extra = {}) => ({ name: 't', start: '2026-10-05', holidays: [], tasks, ...extra });
// 2026-10-05 is a Monday.

test('ISO round trip and validation', () => {
  eq(toISO(parseISO('2026-10-05')), '2026-10-05');
  eq(parseISO('2026-02-30'), null);
  eq(parseISO('garbage'), null);
});

test('calendar skips weekends and holidays', () => {
  const cal = new Calendar('2026-10-05', [{ date: '2026-10-07' }]);
  eq([0, 1, 2, 3, 4].map(i => toISO(cal.day(i))),
    ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-12']);
  eq(toISO(cal.day(-1)), '2026-10-02');
  eq(cal.index(parseISO('2026-10-10')), 4); // Saturday rounds to Monday
  eq(cal.index(parseISO('2026-10-03')), 0); // Saturday before start rounds to start
  eq(cal.index(parseISO('2026-10-01')), -2);
});

test('project starting on a weekend starts on next Monday', () => {
  const s = schedule(plan([T('a', 1)], { start: '2026-10-03' }));
  eq(s.rows[0].start, '2026-10-05');
});

test('finish-to-start chain and dates', () => {
  const a = T('a', 3), b = T('b', 2, [a.id]);
  const s = schedule(plan([a, b]));
  eq([s.rows[0].start, s.rows[0].finish], ['2026-10-05', '2026-10-07']);
  eq([s.rows[1].start, s.rows[1].finish], ['2026-10-08', '2026-10-09']);
  eq(s.finish, '2026-10-09');
});

test('critical path and float', () => {
  // a(5) -> c(1); b(2) -> c.  a is critical, b has 3 days float.
  const a = T('a', 5), b = T('b', 2), c = T('c', 1, [a.id, b.id]);
  const s = schedule(plan([a, b, c]));
  const r = id => s.byId.get(id);
  eq([r(a.id).critical, r(b.id).critical, r(c.id).critical], [true, false, true]);
  eq(r(b.id).float, 3);
});

test('parallel path end slack', () => {
  const a = T('a', 10), b = T('b', 4);
  const s = schedule(plan([a, b]));
  eq(s.byId.get(b.id).float, 6);
});

test('milestone after task shows on task finish date', () => {
  const a = T('a', 5), m = T('m', 0, [a.id]), b = T('b', 1, [m.id]);
  const s = schedule(plan([a, m, b]));
  eq(s.rows[1].start, '2026-10-09');
  eq(s.rows[1].milestone, true);
  eq(s.rows[2].start, '2026-10-12');
});

test('pinned task with conflict is kept and flagged', () => {
  const a = T('a', 5), b = T('b', 2, [a.id], { manualStart: '2026-10-07' });
  const s = schedule(plan([a, b]));
  eq(s.rows[1].start, '2026-10-07');
  eq(s.rows[1].issues.some(x => /predecessor/.test(x)), true);
});

test('pinned task later than predecessors delays successors', () => {
  const a = T('a', 1), b = T('b', 1, [a.id], { manualStart: '2026-10-12' }), c = T('c', 1, [b.id]);
  const s = schedule(plan([a, b, c]));
  eq(s.rows[2].start, '2026-10-13');
  eq(s.rows[1].issues, []);
});

test('pinned milestone on a date', () => {
  const m = T('m', 0, [], { manualStart: '2026-10-09' }), b = T('b', 1, [m.id]);
  const s = schedule(plan([m, b]));
  eq(s.rows[0].start, '2026-10-09');
  eq(s.rows[1].start, '2026-10-12');
});

test('summary rollup', () => {
  const sum = T('phase', 0, [], { level: 0 });
  const a = T('a', 3, [], { level: 1, pct: 100 });
  const b = T('b', 2, [a.id], { level: 1, pct: 0 });
  const after = T('after', 1, [b.id]);
  const s = schedule(plan([sum, a, b, after]));
  const r = s.rows[0];
  eq([r.summary, r.start, r.finish, r.duration, r.pct], [true, '2026-10-05', '2026-10-09', 5, 60]);
  eq(s.rows[1].parent, sum.id);
  eq(s.rows[3].parent, null);
});

test('summary predecessor is ignored with an issue', () => {
  const sum = T('phase', 0), a = T('a', 3, [], { level: 1 }), b = T('b', 1, [sum.id]);
  const s = schedule(plan([sum, a, b]));
  eq(s.rows[2].start, '2026-10-05');
  eq(s.rows[2].issues.length, 1);
});

test('cycle is detected and does not hang', () => {
  const a = T('a', 1), b = T('b', 1, [a.id]);
  a.preds = [b.id];
  const s = schedule(plan([a, b]));
  eq(s.rows.every(r => r.issues.includes('Circular dependency')), true);
});

const SS = id => ({ id, type: 'SS' }), FF = id => ({ id, type: 'FF' }), FS = id => ({ id, type: 'FS' });

test('SS: successor starts with predecessor; float from backward pass', () => {
  // x(2) -> a(5) FS; b(3) SS a.  a runs Oct 7-13, b Oct 7-9 with 2 days float.
  const x = T('x', 2), a = T('a', 5, [FS(x.id)]), b = T('b', 3, [SS(a.id)]);
  const s = schedule(plan([x, a, b]));
  const r = id => s.byId.get(id);
  eq([r(a.id).start, r(a.id).finish], ['2026-10-07', '2026-10-13']);
  eq([r(b.id).start, r(b.id).finish], ['2026-10-07', '2026-10-09']);
  eq([r(b.id).float, r(b.id).critical, r(a.id).critical], [2, false, true]);
});

test('SS: short predecessor of a long task is critical', () => {
  // a(2) SS-> b(6): delaying a's start delays b, so a has no float.
  const a = T('a', 2), b = T('b', 6, [SS(a.id)]);
  const s = schedule(plan([a, b]));
  eq([s.byId.get(a.id).float, s.byId.get(a.id).critical], [0, true]);
});

test('FF: successor finishes with predecessor', () => {
  // a(5) Oct 5-9; b(2) FF a -> Oct 8-9. Both critical.
  const a = T('a', 5), b = T('b', 2, [FF(a.id)]);
  const s = schedule(plan([a, b]));
  const r = id => s.byId.get(id);
  eq([r(b.id).start, r(b.id).finish], ['2026-10-08', '2026-10-09']);
  eq([r(a.id).critical, r(b.id).critical], [true, true]);
});

test('FF: longer successor does not start before the project', () => {
  const a = T('a', 2), b = T('b', 5, [FF(a.id)]);
  const s = schedule(plan([a, b]));
  eq([s.byId.get(b.id).start, s.byId.get(b.id).finish], ['2026-10-05', '2026-10-09']);
});

test('mixed link types: latest constraint wins', () => {
  // a(5) Oct 5-9; c(3) after x(1) FS and SS a; d(2) FF a and FS x.
  const a = T('a', 5), x = T('x', 1), c = T('c', 3, [FS(x.id), SS(a.id)]), d = T('d', 2, [FF(a.id), FS(x.id)]);
  const s = schedule(plan([a, x, c, d]));
  eq(s.byId.get(c.id).start, '2026-10-06'); // FS x (Oct 6) beats SS a (Oct 5)
  eq(s.byId.get(d.id).start, '2026-10-08'); // FF a (finish Oct 9) beats FS x
});

test('pinned dates that violate SS or FF are flagged with the link type', () => {
  const x = T('x', 3), a = T('a', 5, [FS(x.id)]);
  const b = T('b', 2, [SS(a.id)], { manualStart: '2026-10-06' });
  const c = T('c', 2, [FF(a.id)], { manualStart: '2026-10-05' });
  const s = schedule(plan([x, a, b, c]));
  eq(s.byId.get(b.id).issues, ['Starts before predecessor 2 starts (SS)']);
  eq(s.byId.get(c.id).issues, ['Finishes before predecessor 2 finishes (FF)']);
});

test('linkDrives marks only the binding link', () => {
  const a = T('a', 5), x = T('x', 1), c = T('c', 3, [FS(x.id), SS(a.id)]);
  const s = schedule(plan([a, x, c]));
  const r = id => s.byId.get(id);
  eq([linkDrives(r(x.id), r(c.id), 'FS'), linkDrives(r(a.id), r(c.id), 'SS')], [true, false]);
});

test('parsePredList and formatLink', () => {
  eq(parsePredList('2, 3SS 5ff; 6 FS'), [{ row: 2, type: 'FS' }, { row: 3, type: 'SS' }, { row: 5, type: 'FF' }, { row: 6, type: 'FS' }]);
  eq(parsePredList(''), []);
  eq(parsePredList('3, 3SS'), [{ row: 3, type: 'FS' }]);
  eq([parsePredList('3SX'), parsePredList('x'), parsePredList('3SF')], [null, null, null]);
  eq([formatLink({ row: 4, type: 'FS' }), formatLink({ row: 4, type: 'SS' })], ['4', '4SS']);
});

test('normalize upgrades bare-id predecessors and drops bad links', () => {
  const p = normalize({ start: '2026-10-05', tasks: [
    { id: 1, name: 'a', duration: 1, preds: [] },
    { id: 2, name: 'b', duration: 1, preds: [1, { id: 1, type: 'SS' }, { id: 1, type: 'XX' }, 'junk'] },
  ] });
  eq(p.tasks[1].preds, [{ id: 1, type: 'FS' }, { id: 1, type: 'SS' }]);
});

test('collapsed groups hide descendants; nested state survives', () => {
  // P > (A, S > (B), C)
  const P = T('P', 0, [], { level: 0 }), A = T('A', 1, [], { level: 1 }), S = T('S', 0, [], { level: 1 });
  const B = T('B', 1, [], { level: 2 }), C = T('C', 1, [], { level: 1 }), D = T('D', 1);
  const p = plan([P, A, S, B, C, D]);
  const ids = () => [...hiddenIds(p, schedule(p))].sort((x, y) => x - y);
  S.collapsed = true;
  eq(ids(), [B.id], 'inner collapsed:');
  P.collapsed = true;
  eq(ids(), [A.id, S.id, B.id, C.id], 'both collapsed:');
  P.collapsed = false;
  eq(ids(), [B.id], 'outer expanded, inner still collapsed:');
  S.collapsed = false; P.collapsed = true;
  eq(ids(), [A.id, S.id, B.id, C.id], 'outer collapsed, inner expanded:');
  P.collapsed = false;
  eq(ids(), [], 'all expanded:');
  A.collapsed = true; // flag on a non-summary has no effect
  eq(ids(), []);
});

test('working Saturdays and/or Sundays', () => {
  // Starts Fri 2026-10-09, 3 days
  const run = opts => { nextId = 900; const a = T('a', 3); return schedule(plan([a], { start: '2026-10-09', ...opts })).rows[0]; };
  eq([run({}).start, run({}).finish], ['2026-10-09', '2026-10-13'], 'default weekends off:');
  eq(run({ satOff: false }).finish, '2026-10-12', 'Saturday worked:');   // Fri, Sat, Mon
  eq(run({ sunOff: false }).finish, '2026-10-12', 'Sunday worked:');     // Fri, Sun, Mon
  eq(run({ satOff: false, sunOff: false }).finish, '2026-10-11', '7-day week:');
  const cal = new Calendar('2026-10-05', [{ date: '2026-10-10' }], { satOff: false });
  eq(cal.isWorkday(parseISO('2026-10-10')), false, 'holiday on a worked Saturday stays off:');
  eq(cal.isWorkday(parseISO('2026-10-17')), true);
});

test('normalize defaults both weekend days to non-working', () => {
  const p = normalize({ start: '2026-10-05', tasks: [] });
  eq([p.satOff, p.sunOff], [true, true]);
  const q = normalize({ start: '2026-10-05', tasks: [], satOff: false });
  eq([q.satOff, q.sunOff], [false, true]);
});

test('CSV export: header, WBS numbers, links, quoting', () => {
  nextId = 700;
  const ph = T('Phase', 0, [], { level: 0 });
  const a = T('Design, "rev A"', 3, [], { level: 1, assignee: 'Sam', notes: 'line1\nline2' });
  const b = T('Build', 2, [{ id: a.id, type: 'SS' }], { level: 1 });
  const m = T('Done', 0, [b.id], { level: 0 });
  const p = plan([ph, a, b, m]);
  const csv = planToCSV(p, schedule(p));
  eq(csv.charCodeAt(0), 0xFEFF, 'BOM:');
  const rows = csv.slice(1).split('\r\n');
  eq(rows[0].split(',').slice(0, 5), ['WBS', 'Row', 'Outline level', 'Task', 'Type']);
  eq(rows[1].startsWith('1,1,1,Phase,Summary,'), true, `summary row: ${rows[1]}`);
  eq(rows[2].startsWith('1.1,2,2,"Design, ""rev A""",Task,3,2026-10-05,2026-10-07,,0,Sam,"line1\nline2",'), true, `quoted row: ${rows[2]}`);
  eq(rows[3].startsWith('1.2,3,2,Build,Task,2,2026-10-05,2026-10-06,2SS,'), true, `SS link by row number: ${rows[3]}`);
  eq(rows[4].startsWith('2,4,1,Done,Milestone,0,'), true, `milestone row: ${rows[4]}`);
});

test('parseCSV: quotes, embedded newlines, semicolons, BOM', () => {
  eq(parseCSV('﻿a,b\r\n"x, ""y""","1\n2"\r\n\r\n'), [['a', 'b'], ['x, "y"', '1\n2']]);
  eq(parseCSV('Task;Duration\nA;3\n'), [['Task', 'Duration'], ['A', '3']]);
});

test('CSV round trip: export then import keeps structure, links and schedule', () => {
  const sp = samplePlan();
  sp.tasks[6].preds = [{ id: 6, type: 'SS' }];
  sp.tasks[7].preds = [{ id: 6, type: 'FF' }];
  sp.tasks[2].manualStart = '2026-10-20';
  const s1 = schedule(sp);
  const { plan: raw, warnings } = csvToPlan(planToCSV(sp, s1), { name: 'rt', parsePreds: parsePredList, isoDate: csvDate });
  const back = normalize(raw);
  eq(warnings, []);
  eq(back.tasks.map(t => [t.name, t.level, t.duration, t.pct, t.assignee]), sp.tasks.map(t => [t.name, t.level, t.duration, t.pct, t.assignee]));
  eq(back.tasks.map(t => t.preds.map(l => `${l.id}${l.type}`).join()), sp.tasks.map(t => linksOf(t).map(l => `${l.id}${l.type}`).join()));
  eq(back.tasks[2].manualStart, '2026-10-20');
  const s2 = schedule({ ...back, start: sp.start });
  eq(s2.rows.map(r => [r.start, r.finish, r.critical]), s1.rows.map(r => [r.start, r.finish, r.critical]));
});

test('CSV import: hand-made sheet with WBS levels, US dates, no Row column', () => {
  const csv = 'WBS,Name,Days,Depends on,Start\n1,Phase,,,\n1.1,Dig,3,,10/5/2026\n1.2,Pour,2,2,\n2,Done,0,3,\n';
  const { plan: raw, warnings } = csvToPlan(csv, { parsePreds: parsePredList, isoDate: csvDate });
  const p = normalize(raw);
  eq(warnings, []);
  eq(p.start, '2026-10-05');
  eq(p.tasks.map(t => [t.name, t.level, t.duration]), [['Phase', 0, 1], ['Dig', 1, 3], ['Pour', 1, 2], ['Done', 0, 0]]);
  eq(p.tasks[2].preds, [{ id: 2, type: 'FS' }]);
});

test('CSV import: bad references warn; missing Task column throws', () => {
  const { warnings } = csvToPlan('Task,Predecessors\nA,9\nB,1\n', { parsePreds: parsePredList, isoDate: csvDate });
  eq(warnings.length, 1);
  let msg = '';
  try { csvToPlan('Foo,Bar\n1,2\n', { parsePreds: parsePredList, isoDate: csvDate }); } catch (e) { msg = e.message; }
  eq(/Task/.test(msg), true, `error: ${msg}`);
  try { csvToPlan('Task\n', { parsePreds: parsePredList, isoDate: csvDate }); msg = ''; } catch (e) { msg = e.message; }
  eq(/at least one task/.test(msg), true, `error: ${msg}`);
});

test('CSV template imports cleanly', () => {
  const { plan: raw, warnings } = csvToPlan(csvTemplate(), { parsePreds: parsePredList, isoDate: csvDate });
  const p = normalize(raw);
  eq(warnings, []);
  eq(p.tasks.map(t => t.name), ['Phase 1', 'Design', 'Build', 'Write test plan', 'Design review', 'Final demo']);
  eq(p.tasks[3].preds, [{ id: 3, type: 'SS' }]);
  eq(p.tasks[4].duration, 0);
  const s = schedule(p);
  eq(s.rows[0].summary && !s.rows[4].summary, true);
});

test('csvDate accepts ISO and US dates only', () => {
  eq(['2026-10-05', '10/5/2026', '1/2/27', '13/1/2026', '2026/10/05', ''].map(csvDate), ['2026-10-05', '2026-10-05', '2027-01-02', null, null, null]);
});

test('near-critical: float within the threshold, default 5, 0 = off', () => {
  // a(5) -> c; b(2) -> c: b has 3 days float
  const run = extra => { nextId = 800; const a = T('a', 5), b = T('b', 2), c = T('c', 1, [a.id, b.id]); const s = schedule(plan([a, b, c], extra)); return s.byId.get(b.id); };
  eq([run({}).near, run({}).critical], [true, false], 'default 5:');
  eq(run({ nearCritical: 3 }).near, true, 'threshold equal to float:');
  eq(run({ nearCritical: 2 }).near, false, 'threshold below float:');
  eq(run({ nearCritical: 0 }).near, false, 'off:');
});

test('near-critical: a pinned finish leaves the chain before it with slack', () => {
  // Chain a(3) -> b(2) -> m, a milestone pinned to Mon 2026-10-19. A pinned
  // milestone sits at the end of its day (boundary 11), so the chain (ends at
  // boundary 5) has 6 working days of float: not critical, and near-critical
  // only once the threshold reaches 6. (The pattern in Kevin's plan, 1.9.0.)
  nextId = 820;
  const a = T('a', 3), b = T('b', 2, [FS(a.id)]), m = T('m', 0, [FS(b.id)], { manualStart: '2026-10-19' });
  const at = n => schedule(plan([a, b, m], n === undefined ? {} : { nearCritical: n })).byId;
  eq([at().get(a.id).float, at().get(a.id).critical, at().get(m.id).critical], [6, false, true]);
  eq([at().get(a.id).near, at(5).get(a.id).near, at(6).get(a.id).near, at(6).get(b.id).near], [false, false, true, true]);
});

test('normalize: nearCritical defaults to 5 and is clamped', () => {
  eq(normalize({ start: '2026-10-05', tasks: [] }).nearCritical, 5);
  eq(normalize({ start: '2026-10-05', tasks: [], nearCritical: 0 }).nearCritical, 0);
  eq(normalize({ start: '2026-10-05', tasks: [], nearCritical: -3 }).nearCritical, 0);
  eq(normalize({ start: '2026-10-05', tasks: [], nearCritical: 'x' }).nearCritical, 5);
});

test('durationBetween counts working days inclusive', () => {
  const cal = new Calendar('2026-10-05', []);
  eq(durationBetween(cal, parseISO('2026-10-05'), parseISO('2026-10-09')), 5);
  eq(durationBetween(cal, parseISO('2026-10-05'), parseISO('2026-10-11')), 5); // ends Sunday
  eq(durationBetween(cal, parseISO('2026-10-05'), parseISO('2026-10-12')), 6);
  eq(durationBetween(cal, parseISO('2026-10-09'), parseISO('2026-10-05')), null);
});

export default results;
