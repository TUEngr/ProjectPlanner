// Smoke test: render the sample plan's Gantt SVG at every zoom and check for
// bad coordinates. Run via ./tests/run.sh.
import { schedule, hiddenIds } from '../js/schedule.js';
import { ganttPrintSVG } from '../js/gantt.js';
import { samplePlan } from '../js/sample.js';
import { pertLayout, pertPrintSVG } from '../js/pert.js';

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

// PERT: 13 task nodes; column = dependency depth
{
  const L = pertLayout(plan, sched);
  const colOf = row => (L.xy.get(sched.rows[row - 1].id).x - 20) / 264;
  const cols = [2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16].map(colOf).join();
  results.push([L.nodes.length === 13 && L.edges.length === 15, `PERT has 13 nodes and 15 edges (${L.nodes.length}, ${L.edges.length})`]);
  results.push([cols === '0,1,2,3,3,4,5,6,6,4,7,8,9', `PERT columns by dependency depth (${cols})`]);
  results.push([L.edges.filter(e => e.crit).length === 9, `PERT critical edges follow the critical path (${L.edges.filter(e => e.crit).length}, expect 9)`]);
  const svg = pertPrintSVG(plan, sched);
  results.push([!/NaN|undefined|Infinity/.test(svg), 'PERT render has valid coordinates']);
}

// Collapse "Detailed design" (row 5, children 6-9)
plan.tasks[4].collapsed = true;
const hidden = hiddenIds(plan, sched);
const csvg = ganttPrintSVG(plan, sched, 'day', hidden);
const labelCount = (csvg.match(/class="g-row"/g) || []).length;
const linkCount = (csvg.match(/class="g-link/g) || []).length;
results.push([[...hidden].join() === '6,7,8,9' && labelCount === 12, `collapsed group hides rows 6-9 (${labelCount} rows drawn)`]);
results.push([linkCount === 11, `links into a collapsed group reroute to it, internal links dropped (${linkCount} arrows, expect 11)`]);
results.push([!/NaN|undefined|Infinity/.test(csvg), 'collapsed render has valid coordinates']);
results.push([(csvg.match(/class="g-link critical/g) || []).length === 7, `merged link into a collapsed group stays critical (${(csvg.match(/class="g-link critical/g) || []).length} critical arrows, expect 7: 2-3, 3-4, 4-DD, DD-11, 11-14, 14-15, 15-16)`]);

{
  const L = pertLayout(plan, sched, hidden);
  const dd = sched.rows[4].id;
  results.push([L.nodes.length === 10 && L.nodes.some(r => r.id === dd), `collapsed group is one PERT node (${L.nodes.length} nodes, expect 10)`]);
}
export default results;
