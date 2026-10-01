import scheduleResults from './schedule.test.js';
import renderResults from './render.test.js';

const results = [...scheduleResults, ...renderResults];
let failed = 0;
for (const [ok, msg] of results) {
  if (!ok) failed++;
  print(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
}
print(`\n${results.length - failed}/${results.length} passed`);
if (failed) throw new Error(`${failed} test(s) failed`);
