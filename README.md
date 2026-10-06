# Project Planner

A browser-based project planner with a task table and a Gantt chart. The Gantt chart draws dependency arrows and shows the critical path in red.

**Live app:** https://tuengr.github.io/ProjectPlanner/

## Features

- Tasks have a duration in working days, predecessors (finish-to-start, start-to-start `SS`, finish-to-finish `FF`), % complete, an assignee, and notes.
- Tasks can be grouped into summary tasks (indent/outdent), collapsed and expanded, and reordered by dragging. A task with zero duration is a milestone.
- Uses a working-day calendar: each plan has its own holiday list and chooses whether Saturdays and Sundays are worked.
- Start dates can be pinned manually. If a pinned date conflicts with a predecessor, the pin is kept and the task is flagged with ⚠.
- Shows critical path and total float.
- Views: table, Gantt chart, PERT network diagram, and table-plus-chart splits, with undo/redo. A plan can leave out the Gantt or PERT views.
- Table columns and the Gantt task-name column can be resized by dragging (remembered per browser; exports follow them).
- On phones (portrait or landscape) the toolbars collapse into a ☰ drawer, leaving the screen to the chart.

## Saving and sharing

No server is involved. Plans are stored in each user's browser (localStorage).

- **Export → JSON file / Open → JSON file** writes or reads the full plan as JSON, for backups or for moving a plan between machines.
- **Open → CSV file** builds a new plan from a task table (Excel, Google Sheets, or Export → CSV). A failed import offers a template CSV.
- **Export → Read-only link** puts a compressed, read-only copy of the plan in the URL fragment (`#share=…`). The fragment is never sent to a server. Recipients can save their own editable copy.
- **Export → CSV file** downloads the task table (WBS, dates, links, float, critical) for spreadsheets; it can be re-imported.
- **Export → PNG image** downloads the current view (task table, Gantt chart, or PERT diagram) as an image for reports.
- **Export → Print** prints the current view (task table, Gantt chart, or PERT diagram), or saves it as a PDF.

## Development

Plain ES modules with no build step. To serve locally:

```sh
python3 -m http.server 8765
```

Tests:

- `./tests/run.sh` runs the scheduler and render tests with macOS's built-in JavaScriptCore (no Node needed).
- `tests/index.html` runs the same tests in a browser.
- `tests/ui.html` drives the real app in an iframe.
- `tests/mobile.html` checks the phone layout in phone-sized frames (landscape and portrait).
