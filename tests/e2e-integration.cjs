// End-to-end checks for where repo mode meets the rest of the app: importing files,
// the Settings screen, and the phone layout (menu drawer).
//
//   node tests/e2e-integration.cjs      (PLAYWRIGHT_MODULE / PW_CHROMIUM as for the other e2e tests)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const L = require('./e2e-lib.cjs');
const { git, sleep, waitFor, names, statusText, open, readTasks, taskNames } = L;
const R = L.reporter(); const check = R.check;
const E = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-int-'));
const planJson = dir => JSON.parse(fs.readFileSync(path.join(dir, 'data/plan.json'), 'utf8'));

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  await L.seed(browser, E, 9100);
  const { A } = L.pair(E, 'int', 9101, 9102); await sleep(900);
  const confirms = [];
  let answer = true;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('dialog', d => { confirms.push(d.message()); d.accept().catch(() => {}); });
  page.on('pageerror', e => console.log('PAGE ERROR:', e.message));
  await open(page, A.url, 3);

  console.log('\n# Settings: the near-critical threshold reaches the repository');
  await page.click('#btn-settings');
  await page.fill('#settings-form [name=nearCritical]', '5');
  await page.click('#settings-form button[value=save]');
  check(await waitFor(() => planJson(A.dir).nearCritical === 5), 'data/plan.json records nearCritical = 5');
  await page.click('#btn-settings');
  await page.fill('#settings-form [name=nearCritical]', '0');
  await page.click('#settings-form button[value=save]');
  check(await waitFor(() => planJson(A.dir).nearCritical === 0), '0 (off) is kept, not replaced by the default');

  console.log('\n# Open -> CSV replaces the tasks and keeps the project\'s own settings');
  await page.setInputFiles('#file-input', { name: 'tasks.csv', mimeType: 'text/csv', buffer: Buffer.from('Task,Duration,Predecessors\nAlpha,3,\nBeta,2,1\nGamma,4,2\n') });
  check(await waitFor(async () => (await names(page)).join() === 'Alpha,Beta,Gamma'), `the three CSV tasks are shown (${await names(page)})`);
  check(confirms.some(m => /Replace all 3 tasks in this project with the 3/.test(m) && /name, holidays and settings are kept/.test(m)), 'it asked first, in plain words');
  check(await waitFor(() => taskNames(A.dir).join() === 'Alpha,Beta,Gamma'), 'the old task files were replaced on disk');
  check(readTasks(A.dir).length === 3 && fs.readdirSync(path.join(A.dir, 'data/tasks')).length === 3, 'no leftover task files');
  const t = Object.fromEntries(readTasks(A.dir).map(x => [x.name, x]));
  check(t.Beta.preds.length === 1 && t.Beta.preds[0].id === t.Alpha.id && t.Gamma.preds[0].id === t.Beta.id, 'the links between tasks survived, using the new task ids');
  check(planJson(A.dir).name === 'Merge Project' && planJson(A.dir).nearCritical === 0, 'the project name and settings were kept');
  await page.click('[data-cmd="undo"]');
  check(await waitFor(async () => (await names(page)).join() === 'Design,Build,Test'), 'Undo brings the old tasks back');
  check(await waitFor(() => taskNames(A.dir).join() === 'Design,Build,Test'), 'and the disk follows');

  console.log('\n# Open -> JSON replaces the whole plan but keeps the plan id');
  const idBefore = planJson(A.dir).id;
  const json = { format: 1, id: 'other-id', name: 'From JSON', start: '2026-10-05', tasks: [{ id: 1, name: 'J1', duration: 2 }, { id: 2, name: 'J2', duration: 3, preds: [1] }] };
  await page.setInputFiles('#file-input', { name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  check(await waitFor(async () => (await names(page)).join() === 'J1,J2'), 'the JSON plan is shown');
  check(await waitFor(() => planJson(A.dir).name === 'From JSON' && planJson(A.dir).id === idBefore), 'the project is renamed but keeps its plan id');
  const j = Object.fromEntries(readTasks(A.dir).map(x => [x.name, x]));
  check(j.J2.preds[0].id === j.J1.id && /^[a-z0-9]+$/.test(j.J1.id), 'old integer ids became valid file-safe ids with the link intact');

  await page.close();

  console.log('\n# phone layout in a project repository');
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  phone.on('pageerror', e => console.log('PAGE ERROR:', e.message));
  await phone.goto(A.url);
  await waitFor(async () => (await phone.$$('#tbody tr[data-id]')).length === 2);
  await phone.click('#btn-drawer');
  await sleep(400);
  check(await phone.isVisible('#dr-sync'), 'the menu has a Sync entry');
  check(await phone.isHidden('#drawer [data-proxy="#btn-plans"]') && await phone.isHidden('#drawer [data-proxy="#btn-share"]'), 'Plans and Read-only link are not offered');
  check(/Saved to disk/.test(await phone.textContent('#dr-status')), `the menu shows the save status (“${(await phone.textContent('#dr-status')).replace(/\s+/g, ' ').slice(0, 60)}”)`);
  check(await phone.isHidden('#dr-repo'), 'no repository link when the remote is not a GitHub address');
  check(await phone.isHidden('#repo-link'), 'and no header link crowding the phone app bar');
  await phone.click('#dr-sync');
  check(await waitFor(() => phone.isVisible('#dlg-sync'), 10000), 'tapping Sync opens the commit dialog');
  await phone.close();

  console.log('\n# phone layout of a published read-only plan');
  {
    const { execFileSync, spawn } = require('child_process');
    const repo = path.join(E, 'pubrepo'); fs.mkdirSync(path.join(repo, '.github'), { recursive: true });
    for (const f of ['index.html', 'css', 'js']) execFileSync('cp', ['-r', path.join(L.SRC, f), repo]);
    execFileSync('cp', ['-r', path.join(L.SRC, '.github', 'scripts'), path.join(repo, '.github')]);
    execFileSync('cp', ['-r', path.join(A.dir, 'data'), repo]);
    const out = path.join(E, 'site');
    execFileSync('bash', [path.join(repo, '.github/scripts/build-site.sh'), out], { env: { ...process.env, GITHUB_REPOSITORY: 'o/r', PUBLISH_PLAN: 'true' }, stdio: 'ignore' });
    const srv = spawn('python3', ['-m', 'http.server', '9110', '--bind', '127.0.0.1'], { cwd: out, stdio: 'ignore' });
    await sleep(800);
    const pv = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await pv.goto('http://127.0.0.1:9110/');
    await waitFor(async () => (await pv.textContent('#plan-name')) === 'From JSON');
    check(await pv.isVisible('#viewer-banner'), 'the read-only banner stays visible on a phone');
    await pv.click('#btn-drawer'); await sleep(400);
    check(await pv.isVisible('#drawer .viewer-only') && await pv.isVisible('#dr-viewer-edit'), 'the menu explains it is read-only and offers Open in Codespaces');
    check(await pv.isHidden('#drawer .readonly-only'), 'and does NOT offer “Save a copy to my plans”');
    check(await pv.isVisible('#dr-repo') && /o\/r/.test(await pv.textContent('#dr-repo')), 'the menu links to the repository');
    await pv.close(); srv.kill();
  }

  await browser.close();
  L.killAll();
  const code = R.done();
  fs.rmSync(E, { recursive: true, force: true });
  process.exit(code);
})().catch(e => { console.error('HARNESS ERROR', e); L.killAll(); process.exit(2); });
