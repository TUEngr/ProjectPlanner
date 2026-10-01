// Scheduler unit tests. Run with macOS's built-in JavaScriptCore:
//   ./tests/run.sh
// or open tests/index.html in a browser.

import { Calendar, parseISO, toISO } from '../js/calendar.js';
import { schedule, durationBetween } from '../js/schedule.js';

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

test('durationBetween counts working days inclusive', () => {
  const cal = new Calendar('2026-10-05', []);
  eq(durationBetween(cal, parseISO('2026-10-05'), parseISO('2026-10-09')), 5);
  eq(durationBetween(cal, parseISO('2026-10-05'), parseISO('2026-10-11')), 5); // ends Sunday
  eq(durationBetween(cal, parseISO('2026-10-05'), parseISO('2026-10-12')), 6);
  eq(durationBetween(cal, parseISO('2026-10-09'), parseISO('2026-10-05')), null);
});

export default results;
