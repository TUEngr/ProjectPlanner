// Scheduler unit tests. Run with macOS's built-in JavaScriptCore:
//   ./tests/run.sh
// or open tests/index.html in a browser.

import { Calendar, parseISO, toISO } from '../js/calendar.js';
import { schedule, durationBetween, linkDrives } from '../js/schedule.js';
import { parsePredList, formatLink } from '../js/table.js';
import { normalize } from '../js/storage.js';

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

test('durationBetween counts working days inclusive', () => {
  const cal = new Calendar('2026-10-05', []);
  eq(durationBetween(cal, parseISO('2026-10-05'), parseISO('2026-10-09')), 5);
  eq(durationBetween(cal, parseISO('2026-10-05'), parseISO('2026-10-11')), 5); // ends Sunday
  eq(durationBetween(cal, parseISO('2026-10-05'), parseISO('2026-10-12')), 6);
  eq(durationBetween(cal, parseISO('2026-10-09'), parseISO('2026-10-05')), null);
});

export default results;
