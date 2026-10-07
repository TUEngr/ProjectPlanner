// Same suite as jsc-main.js, for environments with Node instead of macOS JavaScriptCore.
import scheduleResults from './schedule.test.js';
import renderResults from './render.test.js';
import storageResults from './storage.test.js';

const results = [...scheduleResults, ...renderResults, ...storageResults];
let failed = 0;
for (const [ok, msg] of results) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
