// End-to-end test of repo mode: two people (Alice, Bob), each with their own clone,
// helper server and browser page, sharing a bare git remote. Covers first run,
// autosave, Sync, merging different tasks, conflicts, disk changes under an open
// page, collapse state staying out of git, and the helper going away.
//
//   node tests/e2e-repo.cjs
//
// Needs Playwright with a Chromium: set PLAYWRIGHT_MODULE (path to the playwright
// package) and PW_CHROMIUM (path to a Chromium executable) if they are not the defaults.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const os = require('os');
const SRC = path.resolve(__dirname, '..');
const SC = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-'));
const E = path.join(SC, 'e2e3'); fs.rmSync(E, { recursive: true, force: true }); fs.mkdirSync(E, { recursive: true });
const sh = (cwd, ...a) => execFileSync(a[0], a.slice(1), { cwd, encoding: 'utf8' });
const git = (cwd, ...a) => sh(cwd, 'git', ...a);
let pass = 0, fail = 0;
const check = (ok, msg) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 100) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) return false; await sleep(step); } }

// remote + clone A (seeded with the app code) + clone B
git(E, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
git(E, 'clone', '-q', 'remote.git', 'A');
const A = path.join(E, 'A'), B = path.join(E, 'B');
for (const f of ['index.html', 'css', 'js', 'server']) sh(SRC, 'cp', '-r', f, A);
git(A, 'config', 'user.name', 'Alice'); git(A, 'config', 'user.email', 'a@x');
git(A, 'checkout', '-q', '-b', 'main'); git(A, 'add', '-A'); git(A, 'commit', '-qm', 'app'); git(A, 'push', '-q', '-u', 'origin', 'main');
git(E, 'clone', '-q', 'remote.git', 'B'); git(B, 'config', 'user.name', 'Bob'); git(B, 'config', 'user.email', 'b@x');
const servers = [];
const start = (dir, port) => { const p = spawn('python3', ['server/serve.py', '--port', String(port)], { cwd: dir, stdio: 'ignore' }); servers.push(p); return p; };
const srvA = start(A, 8861), srvB = start(B, 8862);
const disk = (dir) => { const d = path.join(dir, 'data'); const out = {}; if (!fs.existsSync(d)) return out; for (const f of ['plan.json', ...(fs.existsSync(d + '/tasks') ? fs.readdirSync(d + '/tasks').map(n => 'tasks/' + n) : [])]) if (fs.existsSync(path.join(d, f))) out[f] = fs.readFileSync(path.join(d, f), 'utf8'); return out; };
const taskNames = dir => Object.entries(disk(dir)).filter(([k]) => k.startsWith('tasks/')).map(([, v]) => JSON.parse(v).name);

(async () => {
  await sleep(1200);
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const pa = await browser.newPage({ viewport: { width: 1280, height: 800 } }), pb = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  for (const [n, p] of [['A', pa], ['B', pb]]) { p.on('pageerror', e => console.log(`PAGE ERROR ${n}:`, e.message)); p.on('dialog', d => d.accept()); }
  const names = p => p.$$eval('#tbody tr[data-id] input[data-f="name"]', els => els.map(e => e.value));
  const rename = async (p, i, text) => { const inp = (await p.$$('#tbody tr[data-id] input[data-f="name"]'))[i]; await inp.fill(text); await inp.press('Tab'); };
  const addTask = async (p, text) => { await p.click('[data-cmd="add"]'); await sleep(100); await p.keyboard.type(text); await p.keyboard.press('Tab'); };
  const statusText = p => p.textContent('#status .save-state');

  // 1. first run in an empty clone creates the plan on disk
  await pa.goto('http://127.0.0.1:8861/');
  await waitFor(async () => (await pa.$$('#tbody tr[data-id]')).length === 1);
  check(await pa.evaluate(() => document.body.classList.contains('repo-mode')), 'repo mode is on when served by the helper');
  check(await waitFor(() => fs.existsSync(path.join(A, 'data/plan.json'))), 'first run writes data/plan.json');
  check(await pa.isVisible('#dlg-settings'), 'new project opens Settings so it can be named');
  check(await pa.isHidden('#btn-plans') && await pa.isHidden('#btn-share') && await pa.isVisible('#btn-sync'), 'Plans/Share hidden, Sync shown');
  await pa.fill('#settings-form [name=name]', 'E2E Project'); await pa.click('#settings-form button[value=save]');
  check(await waitFor(() => JSON.parse(disk(A)['plan.json']).name === 'E2E Project'), 'settings change is saved to data/plan.json');

  // 2. autosave of task edits, one file per task
  await rename(pa, 0, 'Design');
  await addTask(pa, 'Build'); await addTask(pa, 'Test');
  check(await waitFor(() => taskNames(A).sort().join() === 'Build,Design,Test'), `three tasks autosaved as three files (${taskNames(A).sort()})`);
  check(!/collapsed|updated|nextId/.test(Object.values(disk(A)).join('')), 'no per-user or time fields in the files');
  check(/Saved to disk/.test(await statusText(pa)), `status shows saved (“${await statusText(pa)}”)`);

  // 3. Sync from the UI commits and pushes with Alice as author
  await pa.click('#btn-sync');
  check(await waitFor(() => pa.isVisible('#dlg-sync'), 10000), 'Sync opens a commit-message dialog when there are changes');
  const msg = await pa.inputValue('#sync-form [name=message]');
  check(/^Update plan settings and 3 tasks$/.test(msg), `default message summarises the change (“${msg}”)`);
  await pa.click('#sync-form button[value=sync]');
  check(await waitFor(() => git(E, '--git-dir=remote.git', 'log', '-1', '--format=%an|%s').trim().startsWith('Alice|Update plan'), 15000), 'commit reached the remote, authored by Alice');
  await waitFor(async () => /in sync/.test(await statusText(pa)), 10000);
  check(/in sync/.test(await statusText(pa)), `status says in sync after Sync (“${await statusText(pa)}”)`);

  // 4. Bob clones, edits a different task, both sync, no conflict
  git(B, 'pull', '-q', 'origin', 'main');
  await pb.goto('http://127.0.0.1:8862/');
  await waitFor(async () => (await pb.$$('#tbody tr[data-id]')).length === 3);
  check((await names(pb)).join() === 'Design,Build,Test', `Bob sees Alice's plan (${await names(pb)})`);
  await rename(pb, 2, 'Test (Bob)');
  await rename(pa, 0, 'Design (Alice)');
  await waitFor(() => taskNames(A).includes('Design (Alice)') && taskNames(B).includes('Test (Bob)'));
  await pb.click('#btn-sync'); await pb.click('#sync-form button[value=sync]');
  await waitFor(async () => /in sync/.test(await statusText(pb)), 15000);
  await pa.click('#btn-sync'); await pa.click('#sync-form button[value=sync]');
  check(await waitFor(async () => (await names(pa)).join() === 'Design (Alice),Build,Test (Bob)', 15000), `Alice's page shows Bob's change after Sync, keeping her own (${await names(pa)})`);
  check(!(await pa.isVisible('#dlg-problem')), 'no conflict for edits to different tasks');

  // 5. Same task on both sides -> clear conflict message, nothing lost, merge aborted
  await rename(pa, 1, 'Build v-Alice');
  await rename(pb, 1, 'Build v-Bob');
  await waitFor(() => taskNames(A).includes('Build v-Alice') && taskNames(B).includes('Build v-Bob'));
  await pa.click('#btn-sync'); await pa.click('#sync-form button[value=sync]');
  await waitFor(async () => /in sync/.test(await statusText(pa)), 15000);
  await pb.click('#btn-sync'); await pb.click('#sync-form button[value=sync]');
  check(await waitFor(() => pb.isVisible('#dlg-merge'), 15000), 'a same-task conflict opens the choose-a-version dialog');
  const body = await pb.textContent('#dlg-merge');
  check(body.includes('Yours: Build v-Bob') && body.includes('Theirs: Build v-Alice'), 'it shows both versions of the clashing field');
  await pb.click('#btn-merge-cancel'); // resolving is covered by tests/e2e-merge.cjs; here, cancelling must change nothing
  check(git(B, 'status', '--porcelain').trim() === '' && !/<<<<<<<|>>>>>>>/.test(Object.values(disk(B)).join('')), 'cancelling leaves Bob\'s tree clean: merge aborted, no conflict markers');
  check(taskNames(B).includes('Build v-Bob'), 'Bob\'s version is still on disk');
  check(!(await pb.isDisabled('#btn-sync')) && !(await pb.evaluate(() => document.body.classList.contains('syncing'))), 'the UI is usable again');

  // 6. disk changed underneath while editing the same task: conflict dialog, choose mine
  const taskFileA = fs.readdirSync(path.join(A, 'data/tasks')).find(f => JSON.parse(fs.readFileSync(path.join(A, 'data/tasks', f), 'utf8')).name === 'Build v-Alice');
  const tp = path.join(A, 'data/tasks', taskFileA);
  fs.writeFileSync(tp, fs.readFileSync(tp, 'utf8').replace('Build v-Alice', 'Build (changed on disk)'));
  await rename(pa, 1, 'Build (mine)');
  check(await waitFor(() => pa.isVisible('#dlg-conflict'), 8000), 'same task changed on disk and in the page opens the chooser');
  check(/Build \(mine\)/.test(await pa.textContent('#conflict-list')) && /changed on disk/.test(await pa.textContent('#conflict-list')), 'chooser shows both versions');
  check(JSON.parse(fs.readFileSync(tp, 'utf8')).name === 'Build (changed on disk)', 'nothing overwritten while the chooser is open');
  await pa.click('#btn-keep-mine');
  check(await waitFor(() => JSON.parse(fs.readFileSync(tp, 'utf8')).name === 'Build (mine)'), '“Keep my changes” writes my version');

  // 7. a different task changed on disk (e.g. a pull in the terminal) merges silently on the next edit
  const other = fs.readdirSync(path.join(A, 'data/tasks')).find(f => f !== taskFileA && JSON.parse(fs.readFileSync(path.join(A, 'data/tasks', f), 'utf8')).name.startsWith('Design'));
  const op = path.join(A, 'data/tasks', other);
  fs.writeFileSync(op, fs.readFileSync(op, 'utf8').replace(/"name": "[^"]*"/, '"name": "Design (from terminal pull)"'));
  await rename(pa, 1, 'Build (mine 2)');
  check(await waitFor(async () => (await names(pa))[0] === 'Design (from terminal pull)' && (await names(pa))[1] === 'Build (mine 2)', 8000), `page picks up the external change and keeps my edit (${await names(pa)})`);
  check(!(await pa.isVisible('#dlg-conflict')), 'no chooser for non-overlapping changes');

  // 8. collapse state is per person: toggling it writes nothing to the repo files
  await pa.click('#tbody tr[data-id]:nth-child(3)'); // select "Test (Bob)"
  await pa.click('[data-cmd="indent"]');             // make it a child of "Build (mine 2)"
  await waitFor(() => Object.values(disk(A)).some(v => JSON.parse(v).level === 1));
  const filesBefore = JSON.stringify(disk(A));
  const treeBefore = git(A, 'status', '--porcelain');
  await pa.click('#tbody tr[data-id]:nth-child(2) [data-act="toggle"]');
  await sleep(1200);
  check((await pa.$$eval('#tbody tr[data-id]', r => r.length)) === 2, 'collapsing a group hides its child in the page');
  check(JSON.stringify(disk(A)) === filesBefore && git(A, 'status', '--porcelain') === treeBefore, 'collapsing changes no file in the repo');
  check(!/collapsed/.test(Object.values(disk(A)).join('')), 'no “collapsed” field anywhere in data/');

  // 9. reload restores from disk, not from browser storage
  await pa.reload();
  await waitFor(async () => (await pa.$$('#tbody tr[data-id]')).length === 2);
  const ordered = (await names(pa)).join();
  check(ordered === 'Design (from terminal pull),Build (mine 2)', `after reload the collapsed child is still hidden and order is from disk (${ordered})`);
  check(taskNames(A).length === 3, 'but the collapsed task is still in the repo');
  check(await pa.evaluate(() => !Object.keys(localStorage).some(k => k.startsWith('projectplanner.plan.'))), 'the plan itself is not stored in browser storage');

  // 10. helper stopped: edits cannot be saved, and the page says so
  srvA.kill(); await sleep(600);
  await rename(pa, 1, 'Offline edit');
  check(await waitFor(async () => /Not saved/.test(await statusText(pa)), 8000), `status warns when the helper is unreachable (“${(await statusText(pa)).slice(0, 70)}”)`);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  await browser.close();
  servers.forEach(s => s.kill());
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); servers.forEach(s => s.kill()); process.exit(2); });
