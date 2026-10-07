// End-to-end test of the published site: build it with the real build script from a
// repo that holds a real plan, serve it, and open it in a browser.
//
//   node tests/e2e-pages.cjs        (PLAYWRIGHT_MODULE / PW_CHROMIUM as for the other e2e tests)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { reporter, waitFor, sleep, SRC } = require('./e2e-lib.cjs');
const R = reporter(); const check = R.check;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pages-'));
const node = (code) => execFileSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: SRC });

// A repo with a real plan in data/, written by the app's own serializer.
const repo = path.join(T, 'repo');
fs.mkdirSync(path.join(repo, '.github'), { recursive: true });
for (const f of ['index.html', 'css', 'js']) execFileSync('cp', ['-r', path.join(SRC, f), repo]);
execFileSync('cp', ['-r', path.join(SRC, '.github', 'scripts'), path.join(repo, '.github')]);
node(`import { samplePlan } from './js/sample.js'; import { planToFiles } from './js/planfiles.js'; import fs from 'fs'; import path from 'path';
const plan = samplePlan(); plan.name = 'Public Demo Project';
for (const [p, text] of Object.entries(planToFiles(plan))) { const f = path.join(${JSON.stringify(repo)}, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }`);
const shareFragment = node(`import { samplePlan } from './js/sample.js'; import { encodeShare } from './js/storage.js';
const p = samplePlan(); p.name = 'Shared Link Plan'; process.stdout.write(await encodeShare(p));`);

const build = (name, env) => {
  const out = path.join(T, name);
  execFileSync('bash', [path.join(repo, '.github/scripts/build-site.sh'), out], { env: { ...process.env, GITHUB_REPOSITORY: 'o/r', ...env }, stdio: 'ignore' });
  return out;
};
const servers = [];
const serve = (dir, port) => { const p = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' }); servers.push(p); return p; };
const rows = p => p.$$eval('#tbody tr[data-id]', r => r.length);

(async () => {
  const optedIn = build('site-public', { PUBLISH_PLAN: 'true' });
  const optedOut = build('site-private', {});
  const corrupt = build('site-corrupt', { PUBLISH_PLAN: 'true' });
  fs.writeFileSync(path.join(corrupt, 'data', 'bundle.json'), '{nope');
  serve(optedIn, 8961); serve(optedOut, 8962); serve(corrupt, 8963);
  await sleep(800);
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const open = async (url) => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    const seen = { errors: [], requests: [] };
    page.on('pageerror', e => seen.errors.push(e.message));
    page.on('request', r => seen.requests.push(r.url()));
    await page.goto(url);
    await waitFor(() => page.evaluate(() => !!document.querySelector('#plan-name')?.textContent && document.querySelector('#plan-name').textContent !== 'Untitled'), 8000);
    return { ctx, page, seen };
  };

  console.log('\n# opted in: a read-only view of the plan');
  {
    const { ctx, page, seen } = await open('http://127.0.0.1:8961/');
    check(await page.evaluate(() => document.body.classList.contains('viewer')), 'the page is in viewer mode');
    check((await page.textContent('#plan-name')) === 'Public Demo Project', 'it shows the published plan');
    check((await rows(page)) === 16, `all 16 tasks are shown (${await rows(page)})`);
    check(await page.isVisible('#viewer-banner') && /read-only copy/.test(await page.textContent('#viewer-text')), 'a banner says it is a read-only copy');
    check(await page.isHidden('#readonly-banner'), 'the share-link banner is not shown');
    check(await page.isVisible('#btn-viewer-edit'), 'there is an “Open in Codespaces to edit” button');
    await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
    await page.click('#btn-viewer-edit');
    const opened = await page.evaluate(() => window.__opened);
    check(opened.length === 1 && opened[0][0] === 'https://codespaces.new/o/r' && opened[0][2] === 'noopener', `it opens the Codespaces page for this repository, without handing over the opener (${JSON.stringify(opened[0])})`);
    check((await page.getAttribute('#repo-link', 'href')) === 'https://github.com/o/r' && (await page.textContent('#repo-link')) === 'o/r', 'the header links to the repository');
    for (const sel of ['#btn-plans', '#btn-share', '#btn-settings', '#btn-import', '[data-cmd="add"]', '[data-cmd="delete"]', '#btn-sync']) {
      check(await page.isHidden(sel), `${sel} is hidden`);
    }
    check(await page.$$eval('#tbody input[data-f="name"]', els => els.every(e => e.readOnly)), 'task names cannot be edited');
    check(await page.isEnabled('#btn-export') && await page.isEnabled('#btn-png') && await page.isEnabled('#btn-print'), 'Save file, Export PNG and Print still work');
    await page.keyboard.press('Control+z');
    check((await rows(page)) === 16, 'undo does nothing');
    const keys = await page.evaluate(() => Object.keys(localStorage));
    check(!keys.some(k => k.startsWith('projectplanner.plan.') || k === 'projectplanner.index'), `nothing about the plan is written to browser storage (${keys})`);
    check(seen.errors.length === 0, `no script errors (${seen.errors})`);
    await ctx.close();
  }

  console.log('\n# not opted in: the plain planner, and no probing for a plan');
  {
    const { ctx, page, seen } = await open('http://127.0.0.1:8962/');
    check(!(await page.evaluate(() => document.body.classList.contains('viewer'))) && await page.isHidden('#viewer-banner'), 'no viewer mode');
    check(await page.isVisible('#btn-plans') && (await page.textContent('#plan-name')).includes('Example'), 'it is the ordinary planner with the example plan');
    check(!seen.requests.some(u => u.includes('bundle.json')), 'it never asked for a plan bundle');
    check(!fs.existsSync(path.join(optedOut, 'data')) && !fs.readFileSync(path.join(optedOut, 'index.html'), 'utf8').includes('Public Demo Project'), 'the site folder holds no plan data');
    check((await page.textContent('#repo-link')) === 'o/r', 'the header still links to the repository');
    check(seen.errors.length === 0, `no script errors (${seen.errors})`);
    await ctx.close();
  }

  console.log('\n# a damaged bundle is reported, not shown');
  {
    const { ctx, page, seen } = await open('http://127.0.0.1:8963/');
    check(await waitFor(async () => /published plan/.test(await page.textContent('#toast')), 5000), 'a message says the published plan could not be read');
    check(!(await page.evaluate(() => document.body.classList.contains('viewer'))), 'and it falls back to the ordinary planner');
    check(seen.errors.length === 0, `no script errors (${seen.errors})`);
    await ctx.close();
  }

  console.log('\n# a share link takes priority over the published plan');
  {
    const { ctx, page } = await open(`http://127.0.0.1:8961/#${shareFragment}`);
    check((await page.textContent('#plan-name')) === 'Shared Link Plan', 'the shared plan is shown');
    check(await page.isVisible('#readonly-banner') && await page.isHidden('#viewer-banner'), 'with the share-link banner, not the viewer banner');
    await ctx.close();
  }

  await browser.close();
  servers.forEach(s => s.kill());
  const code = R.done();
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(code);
})().catch(e => { console.error('HARNESS ERROR', e); servers.forEach(s => s.kill()); process.exit(2); });
