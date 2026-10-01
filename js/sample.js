// Example plan shown on first visit.
import { uid, nextMonday, FORMAT_VERSION } from './storage.js';

export function samplePlan() {
  const rows = [
    // [level, name, duration, preds (row numbers), assignee, pct]
    [0, 'Planning', 0, [], '', 0],
    [1, 'Define requirements', 5, [], 'Team', 100],
    [1, 'Concept generation & selection', 5, [2], 'Team', 40],
    [1, 'Preliminary design review', 0, [3], 'Advisor', 0],
    [0, 'Detailed design', 0, [], '', 0],
    [1, 'Mechanical CAD', 10, [4], 'Alex', 0],
    [1, 'Electrical schematic', 8, [4], 'Sam', 0],
    [1, 'PCB layout', 6, [7], 'Sam', 0],
    [1, 'Order parts', 10, [6, 8], 'Jordan', 0],
    [0, 'Build & test', 0, [], '', 0],
    [1, 'Fabricate chassis', 8, [9], 'Alex', 0],
    [1, 'Assemble PCB', 3, [9], 'Sam', 0],
    [1, 'Firmware', 15, [7], 'Jordan', 0],
    [1, 'Integration', 5, [11, 12, 13], 'Team', 0],
    [1, 'Verification testing', 5, [14], 'Team', 0],
    [0, 'Final presentation', 0, [15], 'Team', 0],
  ];
  return {
    format: FORMAT_VERSION,
    id: uid(),
    name: 'Example: senior design project',
    start: nextMonday(),
    holidays: [],
    tasks: rows.map(([level, name, duration, preds, assignee, pct], i) => ({
      id: i + 1, name, level, duration, preds, manualStart: null, pct, assignee, notes: '',
    })),
    nextId: rows.length + 1,
  };
}
