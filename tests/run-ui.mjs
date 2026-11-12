// Run the browser test pages (ui.html, mobile.html) in headless Chrome from
// the command line: node tests/run-ui.mjs [page ...]
//
// Serves the project on a free local port, drives Chrome over the DevTools
// protocol in real time, and prints failures and the pass count for each page.
// Exits non-zero if any check fails. Needs Node 22+ (built-in WebSocket) and
// Chrome; set CHROME to its path if it isn't in the usual place.
//
// Real time matters: Chrome's --virtual-time-budget skips timers without
// waiting for file reads, so import tests would check results too early.
// Focus emulation matters too: without it a headless page never has focus,
// so cell edits (committed on focusout) never commit.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PAGES = process.argv.slice(2).length ? process.argv.slice(2) : ['ui.html', 'mobile.html'];
const CHROME = process.env.CHROME || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[process.platform] || 'google-chrome';
const TIMEOUT_MS = 300000;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.csv': 'text/csv', '.md': 'text/markdown', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Static file server for the project directory (localhost only)
const server = createServer(async (req, res) => {
  const path = resolve(ROOT, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (path !== ROOT && !path.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path.endsWith(sep) || path === ROOT ? join(path, 'index.html') : path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(join(tmpdir(), 'pp-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`,
  '--remote-debugging-port=0', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  chrome.kill();
  server.close();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
chrome.on('error', async e => { console.error(`Could not start Chrome (${CHROME}): ${e.message}. Set CHROME to its path.`); await cleanup(); process.exit(2); });

// Chrome prints the DevTools endpoint on stderr
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  chrome.stderr.on('data', d => { buf += d; const m = /DevTools listening on (ws:\S+)/.exec(buf); if (m) res(m[1]); });
  setTimeout(() => rej(new Error('Chrome did not start')), 20000);
});
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}, sessionId) => new Promise(r => {
  const id = ++seq;
  pending.set(id, r);
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});

let failedPages = 0;
for (const page of PAGES) {
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  await send('Page.navigate', { url: `${base}/tests/${page}` }, sessionId);
  const t0 = Date.now();
  let text = '', lastReport = t0;
  console.log(`== ${page}`);
  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(500);
    const r = await send('Runtime.evaluate', { expression: "document.getElementById('out')?.textContent || ''", returnByValue: true }, sessionId);
    text = r.result?.result?.value || '';
    if (/\d+\/\d+ passed\s*$/.test(text)) break;
    if (Date.now() - lastReport >= 30000) {
      lastReport = Date.now();
      console.log(`   … ${Math.round((lastReport - t0) / 1000)} s, ${text.split('\n').filter(l => /^(PASS|FAIL)/.test(l)).length} checks so far`);
    }
  }
  const lines = text.split('\n');
  const summary = lines.find(l => /\d+\/\d+ passed/.test(l));
  for (const l of lines.filter(l => l.startsWith('FAIL'))) console.log(`   ${l}`);
  if (!summary) { console.log(`   timed out after ${TIMEOUT_MS / 1000} s`); failedPages++; }
  else {
    console.log(`   ${summary.trim()}`);
    const [ok, all] = summary.match(/\d+/g).map(Number);
    if (ok !== all) failedPages++;
  }
  await send('Target.closeTarget', { targetId });
}

ws.close();
await cleanup();
process.exit(failedPages ? 1 : 0);
