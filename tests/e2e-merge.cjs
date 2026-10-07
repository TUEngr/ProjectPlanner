// End-to-end tests of conflict resolution: two people, real git, real browsers.
//
//   node tests/e2e-merge.cjs
//
// Set PLAYWRIGHT_MODULE / PW_CHROMIUM if Playwright is not installed in the default place.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const L = require('./e2e-lib.cjs');
const { git, sleep, waitFor, names, rename, selectRow, statusText, open, syncUI, idle, readTasks, taskNames, parents } = L;
const R = L.reporter();
const check = R.check;

const E = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-merge-'));
let port = 8900;
const nextPorts = () => [port++, port++];
const noMergeInProgress = dir => !fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'));
const clean = dir => git(dir, 'status', '--porcelain', '--untracked-files=no').trim() === '';
const remoteHead = (remote = 'remote.git') => git(E, `--git-dir=${remote}`, 'rev-parse', 'main').trim();
const subject = dir => git(dir, 'log', '-1', '--format=%s').trim();
const diskOf = (dir, name) => readTasks(dir).find(t => t.name === name);

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const newPage = async () => { const p = await browser.newPage({ viewport: { width: 1280, height: 800 } }); p.on('dialog', d => d.accept()); p.on('pageerror', e => console.log('PAGE ERROR:', e.message)); return p; };
  let seedSha;
  const scenario = async (name, fn) => { console.log(`\n# ${name}`); git(E, '--git-dir=remote.git', 'update-ref', 'refs/heads/main', seedSha); // every scenario starts from the same remote
    const [a, b] = nextPorts(); const ctx = L.pair(E, `s${a}`, a, b); const pa = await newPage(), pb = await newPage(); await sleep(900); try { await fn(ctx, pa, pb); } catch (e) { check(false, `${name}: ${e.message}`); } await pa.close(); await pb.close(); };

  await L.seed(browser, E, port++);
  seedSha = remoteHead();
  check(fs.existsSync(path.join(E, 'seed', 'data', 'plan.json')), 'seed: the remote holds a three-task plan');

  // ---- 1. same field on both sides -> a question, then a merge commit that is pushed
  await scenario('same field changed by both', async ({ A, B }, pa, pb) => {
    await open(pa, A.url, 3); await open(pb, B.url, 3);
    await rename(pa, 0, 'Design (Alice)'); await rename(pb, 0, 'Design (Bob)');
    await waitFor(() => taskNames(A.dir)[0] === 'Design (Alice)' && taskNames(B.dir)[0] === 'Design (Bob)');
    await syncUI(pa);
    await pb.click('#btn-sync'); await pb.click('#sync-form button[value=sync]');
    check(await waitFor(() => pb.isVisible('#dlg-merge'), 15000), 'a conflict opens the choose-a-version dialog');
    const text = await pb.textContent('#dlg-merge');
    check(/Name/.test(text) && /Yours: Design \(Bob\)/.test(text) && /Theirs: Design \(Alice\)/.test(text), 'it shows both versions of the field in plain words');
    check(await pb.isDisabled('#btn-merge-finish'), 'Finish is disabled until a version is chosen');
    check((await pb.$$('#merge-body fieldset.clash')).length === 1, 'only the one real clash is asked about');
    await pb.check('#merge-body input[value="theirs"]');
    check(!(await pb.isDisabled('#btn-merge-finish')), 'Finish is enabled once every clash has a choice');
    await pb.click('#btn-merge-finish');
    await idle(pb);
    check(await waitFor(async () => (await names(pb))[0] === 'Design (Alice)'), `the chosen version is shown (${await names(pb)})`);
    check(parents(B.dir).length === 2 && subject(B.dir) === 'Merge teammate changes', 'a merge commit was made');
    check(remoteHead() === git(B.dir, 'rev-parse', 'HEAD').trim(), 'and pushed');
    check(noMergeInProgress(B.dir) && clean(B.dir), 'Bob’s tree is clean, no merge left open');
    check(await waitFor(async () => /in sync/.test(await statusText(pb)), 10000), 'the status bar says in sync');
    await syncUI(pa);
    check(await waitFor(async () => (await names(pa))[0] === 'Design (Alice)') && clean(A.dir), 'Alice syncs and sees the same plan');
  });

  // ---- 2. different fields whose lines touch: git conflicts, the app does not even ask
  await scenario('different fields of one task, no question asked', async ({ A, B }, pa, pb) => {
    await open(pa, A.url, 3); await open(pb, B.url, 3);
    await rename(pa, 1, 'Build renamed');
    await selectRow(pb, 1); await pb.click('[data-cmd="indent"]');
    await waitFor(() => taskNames(A.dir)[1] === 'Build renamed' && readTasks(B.dir).some(t => t.name === 'Build' && t.level === 1));
    await syncUI(pa);
    await pb.click('#btn-sync'); await pb.click('#sync-form button[value=sync]');
    await idle(pb);
    check(!(await pb.isVisible('#dlg-merge')), 'no dialog: the two edits do not clash');
    const t = diskOf(B.dir, 'Build renamed');
    check(!!t && t.level === 1, 'Bob’s disk has Alice’s new name AND Bob’s indent');
    check(subject(B.dir) === 'Merge teammate changes', 'it went through the app’s merge (plain git would have conflicted on neighbouring lines)');
    check(remoteHead() === git(B.dir, 'rev-parse', 'HEAD').trim() && noMergeInProgress(B.dir), 'pushed, nothing left open');
    check((await names(pb)).includes('Build renamed'), 'Bob’s page shows the new name');
  });

  // ---- 3. predecessors added on both sides are both kept
  await scenario('predecessors added on both sides', async ({ A, B }, pa, pb) => {
    await open(pa, A.url, 3); await open(pb, B.url, 3);
    const setPreds = async (p, v) => { const inp = (await p.$$('#tbody tr[data-id] input[data-f="preds"]'))[2]; await inp.fill(v); await inp.press('Tab'); };
    await setPreds(pa, '1'); await setPreds(pb, '2');
    await waitFor(() => readTasks(A.dir).some(t => t.preds.length === 1) && readTasks(B.dir).some(t => t.preds.length === 1));
    await syncUI(pa);
    await pb.click('#btn-sync'); await pb.click('#sync-form button[value=sync]');
    await idle(pb);
    check(!(await pb.isVisible('#dlg-merge')), 'no question for two different predecessors');
    const links = readTasks(B.dir).find(t => t.preds.length)?.preds.map(l => l.id).length;
    check(links === 2, `both predecessors survive on disk (${links})`);
    const shown = await pb.$$eval('#tbody tr[data-id] input[data-f="preds"]', els => els.map(e => e.value));
    check(shown[2].split(',').map(x => x.trim()).sort().join() === '1,2', `the table shows both (“${shown[2]}”)`);
  });

  // ---- 4. deleted by one, edited by the other
  await scenario('deleted by one person, edited by the other', async ({ A, B }, pa, pb) => {
    await open(pa, A.url, 3); await open(pb, B.url, 3);
    await selectRow(pa, 2); await pa.click('[data-cmd="delete"]');
    await rename(pb, 2, 'Test (Bob)');
    await waitFor(() => taskNames(A.dir).length === 2 && taskNames(B.dir)[2] === 'Test (Bob)');
    await syncUI(pa);
    await pb.click('#btn-sync'); await pb.click('#sync-form button[value=sync]');
    check(await waitFor(() => pb.isVisible('#dlg-merge'), 15000), 'a dialog opens');
    const text = await pb.textContent('#dlg-merge');
    check(/deleted/.test(text) && /Keep the task “Test \(Bob\)”/.test(text) && /Delete the task/.test(text), 'it offers keep or delete in plain words');
    await pb.check('#merge-body input[value="ours"]');
    await pb.click('#btn-merge-finish'); await idle(pb);
    check((await names(pb)).join() === 'Design,Build,Test (Bob)', `the task is kept (${await names(pb)})`);
    await syncUI(pa);
    check(await waitFor(async () => (await names(pa)).join() === 'Design,Build,Test (Bob)'), 'and Alice gets it back after her next Sync');
  });

  // ---- 5. cancelling changes nothing, and Sync offers the question again
  await scenario('cancelling the dialog', async ({ A, B }, pa, pb) => {
    await open(pa, A.url, 3); await open(pb, B.url, 3);
    await rename(pa, 0, 'Design (Alice)'); await rename(pb, 0, 'Design (Bob)');
    await waitFor(() => taskNames(A.dir)[0] === 'Design (Alice)' && taskNames(B.dir)[0] === 'Design (Bob)');
    await syncUI(pa);
    const head = git(B.dir, 'rev-parse', 'HEAD').trim();
    await pb.click('#btn-sync'); await pb.click('#sync-form button[value=sync]');
    await waitFor(() => pb.isVisible('#dlg-merge'), 15000);
    await pb.click('#btn-merge-cancel');
    check(await waitFor(async () => /Nothing was merged/.test(await pb.textContent('#toast')), 4000), 'a toast says nothing was merged');
    const bobHead = git(B.dir, 'rev-parse', 'HEAD').trim();
    check(noMergeInProgress(B.dir) && clean(B.dir) && taskNames(B.dir)[0] === 'Design (Bob)', 'Bob’s repo and files are exactly as before');
    check(bobHead !== remoteHead(), 'nothing was pushed');
    await pb.click('#btn-sync');
    check(await waitFor(() => pb.isVisible('#dlg-merge'), 15000), 'pressing Sync again offers the same choice');
  });

  // ---- 6. the remote moves while the dialog is open
  await scenario('the remote moves while deciding', async ({ A, B }, pa, pb) => {
    await open(pa, A.url, 3); await open(pb, B.url, 3);
    await rename(pa, 0, 'Design (Alice)'); await rename(pb, 0, 'Design (Bob)');
    await waitFor(() => taskNames(A.dir)[0] === 'Design (Alice)' && taskNames(B.dir)[0] === 'Design (Bob)');
    await syncUI(pa);
    await pb.click('#btn-sync'); await pb.click('#sync-form button[value=sync]');
    await waitFor(() => pb.isVisible('#dlg-merge'), 15000);
    await rename(pa, 2, 'Test (Alice, later)');          // Alice pushes again while Bob is deciding
    await waitFor(() => taskNames(A.dir)[2] === 'Test (Alice, later)');
    await syncUI(pa);
    const head = git(B.dir, 'rev-parse', 'HEAD').trim();
    await pb.check('#merge-body input[value="theirs"]');
    await pb.click('#btn-merge-finish');
    check(await waitFor(() => pb.isVisible('#dlg-problem'), 15000), 'Bob is told the remote changed again');
    check(/changed again/.test(await pb.textContent('#problem-title')), 'with a clear title');
    check(git(B.dir, 'rev-parse', 'HEAD').trim() === head && noMergeInProgress(B.dir) && clean(B.dir), 'nothing was changed on Bob’s side');
    await pb.click('#dlg-problem .close');
    await pb.click('#btn-sync');
    check(await waitFor(() => pb.isVisible('#dlg-merge'), 15000), 'Sync shows the conflict again');
    await pb.check('#merge-body input[value="theirs"]'); await pb.click('#btn-merge-finish'); await idle(pb);
    check(await waitFor(async () => (await names(pb)).join() === 'Design (Alice),Build,Test (Alice, later)'), `the second attempt succeeds and includes Alice’s later change (${await names(pb)})`);
    check(remoteHead() === git(B.dir, 'rev-parse', 'HEAD').trim(), 'and is pushed');
  });

  // ---- 7. two people start the same new project at once
  console.log('\n# two people create the plan in an empty project at the same time');
  L.seedEmpty(E);
  {
    const [a, b] = nextPorts(); const ctx = L.pair(E, 'empty', a, b, 'remote2.git'); await sleep(900);
    const pa = await newPage(), pb = await newPage();
    await pa.goto(ctx.A.url); await waitFor(() => pa.isVisible('#dlg-settings'));
    await pb.goto(ctx.B.url); await waitFor(() => pb.isVisible('#dlg-settings'));
    await pa.fill('#settings-form [name=name]', 'Alpha'); await pa.click('#settings-form button[value=save]');
    await pb.fill('#settings-form [name=name]', 'Beta'); await pb.click('#settings-form button[value=save]');
    await waitFor(() => fs.existsSync(path.join(ctx.A.dir, 'data/plan.json')) && JSON.parse(fs.readFileSync(path.join(ctx.B.dir, 'data/plan.json'), 'utf8')).name === 'Beta' && JSON.parse(fs.readFileSync(path.join(ctx.A.dir, 'data/plan.json'), 'utf8')).name === 'Alpha');
    await syncUI(pa);
    await pb.click('#btn-sync'); await pb.click('#sync-form button[value=sync]');
    check(await waitFor(() => pb.isVisible('#dlg-merge'), 15000), 'both created plan.json: a dialog opens for Bob');
    const text = await pb.textContent('#dlg-merge');
    check(/Name/.test(text) && /Yours: Beta/.test(text) && /Theirs: Alpha/.test(text), 'it asks only about the project name');
    check((await pb.$$('#merge-body fieldset.clash')).length === 1, 'the plan id and the two starter tasks are not questions');
    await pb.check('#merge-body input[value="theirs"]'); await pb.click('#btn-merge-finish'); await idle(pb);
    check(await waitFor(async () => (await pb.textContent('#plan-name')) === 'Alpha'), 'Bob’s project is now named Alpha');
    check((await names(pb)).length === 2, `both starter tasks are kept (${await names(pb)})`);
    check(remoteHead('remote2.git') === git(ctx.B.dir, 'rev-parse', 'HEAD').trim() && clean(ctx.B.dir), 'pushed and clean');
    await pa.close(); await pb.close();
  }

  await browser.close();
  L.killAll();
  const code = R.done();
  fs.rmSync(E, { recursive: true, force: true });
  process.exit(code);
})().catch(e => { console.error('HARNESS ERROR', e); L.killAll(); process.exit(2); });
