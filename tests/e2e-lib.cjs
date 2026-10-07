// Shared helpers for the end-to-end tests: a seeded remote, two clones per scenario,
// one helper server and one browser page each.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const SRC = path.resolve(__dirname, '..');
const sh = (cwd, cmd, ...a) => execFileSync(cmd, a, { cwd, encoding: 'utf8' });
const git = (cwd, ...a) => sh(cwd, 'git', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 100) {
  const t = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) return false; await sleep(step); }
}

function reporter() {
  let pass = 0, fail = 0;
  return {
    check(ok, msg) { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); },
    done() { console.log(`\n${pass}/${pass + fail} checks passed`); return fail ? 1 : 0; },
  };
}

// Disk helpers for a clone's data/ folder
const dataDir = dir => path.join(dir, 'data', 'tasks');
const taskFiles = dir => (fs.existsSync(dataDir(dir)) ? fs.readdirSync(dataDir(dir)).map(f => path.join(dataDir(dir), f)) : []);
const readTasks = dir => taskFiles(dir).map(f => ({ file: f, ...JSON.parse(fs.readFileSync(f, 'utf8')) }));
const taskNames = dir => readTasks(dir).sort((a, b) => (a.rank < b.rank ? -1 : 1)).map(t => t.name);
const parents = dir => git(dir, 'log', '-1', '--format=%P').trim().split(' ').filter(Boolean);

// A remote that already holds the app and a three-task plan (Design, Build, Test),
// made through the real UI by a first user.
async function seed(browser, E, port) {
  git(E, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  const S = path.join(E, 'seed');
  git(E, 'clone', '-q', 'remote.git', 'seed');
  for (const f of ['index.html', 'css', 'js', 'server']) sh(SRC, 'cp', '-r', f, S);
  git(S, 'config', 'user.name', 'Seed'); git(S, 'config', 'user.email', 's@x');
  git(S, 'checkout', '-q', '-b', 'main'); git(S, 'add', '-A'); git(S, 'commit', '-qm', 'app'); git(S, 'push', '-q', '-u', 'origin', 'main');
  const srv = spawn('python3', ['server/serve.py', '--port', String(port)], { cwd: S, stdio: 'ignore' });
  await sleep(1000);
  const p = await browser.newPage();
  p.on('dialog', d => d.accept());
  await p.goto(`http://127.0.0.1:${port}/`);
  await waitFor(() => p.isVisible('#dlg-settings'));
  await p.fill('#settings-form [name=name]', 'Merge Project'); await p.click('#settings-form button[value=save]');
  await rename(p, 0, 'Design');
  await addTask(p, 'Build'); await addTask(p, 'Test');
  await waitFor(() => taskNames(S).length === 3 && taskNames(S).join() === 'Design,Build,Test');
  await syncUI(p);
  await waitFor(() => git(E, '--git-dir=remote.git', 'log', '-1', '--format=%s').includes('Update'), 15000);
  await p.close(); srv.kill();
}

// A remote holding only the app: a brand-new project nobody has opened yet.
function seedEmpty(E) {
  git(E, 'init', '-q', '--bare', '-b', 'main', 'remote2.git');
  git(E, 'clone', '-q', 'remote2.git', 'seed2');
  const S = path.join(E, 'seed2');
  for (const f of ['index.html', 'css', 'js', 'server']) sh(SRC, 'cp', '-r', f, S);
  git(S, 'config', 'user.name', 'Seed'); git(S, 'config', 'user.email', 's@x');
  git(S, 'checkout', '-q', '-b', 'main'); git(S, 'add', '-A'); git(S, 'commit', '-qm', 'app'); git(S, 'push', '-q', '-u', 'origin', 'main');
}

const servers = [];
function pair(E, tag, portA, portB, remote = 'remote.git') {
  const out = {};
  for (const [who, port] of [['A', portA], ['B', portB]]) {
    const dir = path.join(E, `${tag}-${who}`);
    git(E, 'clone', '-q', remote, dir);
    git(dir, 'config', 'user.name', who === 'A' ? 'Alice' : 'Bob'); git(dir, 'config', 'user.email', `${who.toLowerCase()}@x`);
    const p = spawn('python3', ['server/serve.py', '--port', String(port)], { cwd: dir, stdio: 'ignore' });
    servers.push(p);
    out[who] = { dir, port, url: `http://127.0.0.1:${port}/`, proc: p };
  }
  return out;
}
const killAll = () => servers.forEach(s => s.kill());

// ---- page helpers ----
const names = p => p.$$eval('#tbody tr[data-id] input[data-f="name"]', els => els.map(e => e.value));
async function rename(p, i, text) { const inp = (await p.$$('#tbody tr[data-id] input[data-f="name"]'))[i]; await inp.fill(text); await inp.press('Tab'); }
async function addTask(p, text) { await p.click('[data-cmd="add"]'); await sleep(100); await p.keyboard.type(text); await p.keyboard.press('Tab'); }
async function selectRow(p, i) { await p.click(`#tbody tr[data-id]:nth-child(${i + 1}) td.c-num`); }
const statusText = p => p.textContent('#status .save-state');
async function open(p, url, rows) {
  await p.goto(url);
  await waitFor(async () => (await p.$$('#tbody tr[data-id]')).length === rows, 10000);
  await waitFor(async () => /Saved to disk/.test(await statusText(p)));
}
// Press Sync; confirm the commit-message dialog if there is one; wait until the UI is idle again.
async function syncUI(p) {
  await p.click('#btn-sync');
  if (await waitFor(() => p.isVisible('#dlg-sync'), 1500)) await p.click('#sync-form button[value=sync]');
  await sleep(300);
  await waitFor(() => p.evaluate(() => !document.body.classList.contains('syncing')), 20000);
}
const idle = p => waitFor(() => p.evaluate(() => !document.body.classList.contains('syncing')), 20000);

module.exports = { SRC, sh, git, sleep, waitFor, reporter, seed, seedEmpty, pair, killAll, names, rename, addTask, selectRow, statusText, open, syncUI, idle, readTasks, taskNames, parents };
