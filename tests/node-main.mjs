// Same suite as jsc-main.js, for environments with Node instead of macOS JavaScriptCore.
import scheduleResults from './schedule.test.js';
import renderResults from './render.test.js';
import storageResults from './storage.test.js';
import repoResults, { ready } from './repo.test.js';
import mergeResults from './merge.test.js';
import siteResults, { ready as siteReady } from './site.test.js';

await Promise.all([ready, siteReady]); // async tests finish before reporting

const results = [...scheduleResults, ...renderResults, ...storageResults, ...mergeResults, ...siteResults, ...repoResults];
let failed = 0;
for (const [ok, msg] of results) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
