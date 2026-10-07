import scheduleResults from './schedule.test.js';
import renderResults from './render.test.js';
import storageResults from './storage.test.js';
import repoResults, { ready } from './repo.test.js';
import mergeResults from './merge.test.js';
import siteResults, { ready as siteReady } from './site.test.js';

// repo tests are async; their promises settle without timers, so jsc finishes them
// before the job queue empties.
Promise.all([ready, siteReady]).then(() => {
const results = [...scheduleResults, ...renderResults, ...storageResults, ...mergeResults, ...siteResults, ...repoResults];
let failed = 0;
for (const [ok, msg] of results) {
  if (!ok) failed++;
  print(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
}
print(`\n${results.length - failed}/${results.length} passed`);
if (failed) throw new Error(`${failed} test(s) failed`);
});
