// The published-site helpers (js/site.js).
import { parseSlug, repoUrl, codespacesUrl, loadBundle } from '../js/site.js';
import { samplePlan } from '../js/sample.js';
import { planToFiles } from '../js/planfiles.js';

const results = [];
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); results.push([true, name]); } catch (e) { results.push([false, `${name}: ${e.message}`]); }
  });
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}
const ok = (c, m) => { if (!c) throw new Error(m); };
const resp = (status, body, rawText) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => { if (rawText !== undefined) JSON.parse(rawText); return body; } });

test('slug: accepts real repository names and builds the two links', () => {
  eq(parseSlug('Tudre/ProjectPlanner'), { owner: 'Tudre', name: 'ProjectPlanner', slug: 'Tudre/ProjectPlanner' });
  eq(parseSlug('a-b/c.d_e-f').name, 'c.d_e-f');
  eq(parseSlug('o/.github').name, '.github');
  eq(repoUrl(parseSlug('o/r')), 'https://github.com/o/r');
  eq(codespacesUrl(parseSlug('o/r')), 'https://codespaces.new/o/r');
});

test('slug: rejects anything that is not exactly owner/name', () => {
  for (const bad of ['', null, undefined, 'x', 'a/b/c', '../..', 'a/.', 'a/..', '-a/b', '.a/b', '/b', 'a/', 'a b/c', 'a/b c', 'a/b"><script>', 'a/b\nc', 'javascript:alert(1)//x', 'a/b#c', 'a/b?c', 'a\\b/c']) {
    eq(parseSlug(bad), null, JSON.stringify(bad));
  }
});

test('bundle: no marker means no request and no plan', async () => {
  let called = false;
  eq(await loadBundle(null, async () => { called = true; }), null);
  ok(!called, 'must not fetch without a marker');
});

test('bundle: a good bundle becomes a plan with its commit', async () => {
  const plan = samplePlan();
  const b = { format: 1, commit: 'abc1234', generated: '2026-10-07T00:00:00Z', files: planToFiles(plan) };
  const r = await loadBundle('data/bundle.json', resp(200, b));
  eq([r.plan.tasks.length, r.plan.name, r.commit], [plan.tasks.length, plan.name, 'abc1234']);
});

test('bundle: a missing file is not an error', async () => {
  eq(await loadBundle('data/bundle.json', resp(404, null)), null);
});

test('bundle: every kind of damage is reported, never silently shown', async () => {
  const good = planToFiles(samplePlan());
  const cases = {
    'server error': resp(500, null),
    'not json': resp(200, null, '{nope'),
    'wrong format': resp(200, { format: 2, files: good }),
    'no files': resp(200, { format: 1 }),
    'files not an object': resp(200, { format: 1, files: 'x' }),
    'no plan.json': resp(200, { format: 1, files: {} }),
    'corrupt task': resp(200, { format: 1, files: { ...good, 'data/tasks/t1.json': '<<<<<<< HEAD' } }),
    'network error': async () => { throw new TypeError('x'); },
  };
  for (const [name, fn] of Object.entries(cases)) {
    let msg = '';
    try { await loadBundle('data/bundle.json', fn); } catch (e) { msg = e.message; }
    ok(/published plan/.test(msg), `${name}: expected a clear error, got “${msg}”`);
  }
});

export const ready = chain;
export default results;
