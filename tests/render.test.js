// Smoke test: render the sample plan's Gantt SVG at every zoom and check for
// bad coordinates. Run via ./tests/run.sh.
import { schedule } from '../js/schedule.js';
import { ganttPrintSVG } from '../js/gantt.js';
import { samplePlan } from '../js/sample.js';

const results = [];
const plan = samplePlan();
const sched = schedule(plan);
for (const zoom of ['day', 'week', 'month']) {
  const svg = ganttPrintSVG(plan, sched, zoom);
  const bad = /NaN|undefined|Infinity/.exec(svg);
  results.push([!bad, `render ${zoom} zoom (${svg.length} chars)${bad ? ': found ' + bad[0] : ''}`]);
}
const crit = sched.rows.filter(r => !r.summary && r.critical).map(r => r.row);
results.push([crit.join() === '2,3,4,7,8,9,11,14,15,16', `sample critical path rows: ${crit.join(', ')}`]);
results.push([(ganttPrintSVG(plan, sched, 'day').match(/class="g-link/g) || []).length === 15, 'sample has 15 dependency arrows']);
export default results;
