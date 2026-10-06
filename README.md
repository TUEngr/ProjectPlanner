# Project Planner

A browser-based project planner with a task table and a Gantt chart. The Gantt chart draws dependency arrows and shows the critical path in red.

**Live app:** https://tuengr.github.io/ProjectPlanner/

## Features

- Tasks have a duration in working days, finish-to-start predecessors, % complete, an assignee, and notes.
- Tasks can be grouped into summary tasks (indent/outdent). A task with zero duration is a milestone.
- Uses a working-day calendar: weekends are skipped, and each plan has its own holiday list.
- Start dates can be pinned manually. If a pinned date conflicts with a predecessor, the pin is kept and the task is flagged with ⚠.
- Shows critical path and total float.
- Has table, Gantt, and split views, with undo/redo.

## Saving and sharing

No server is involved. Plans are stored in each user's browser (localStorage).

- **Save file / Open file** writes or reads a JSON file, for backups or for moving a plan between machines.
- **Share link** puts a compressed, read-only copy of the plan in the URL fragment (`#share=…`). The fragment is never sent to a server. Recipients can save their own editable copy.
- **Print** prints the Gantt chart, or saves it as a PDF.

## Development

Plain ES modules with no build step. To serve locally:

```sh
python3 -m http.server 8765
```

Tests:

- `./tests/run.sh` runs the scheduler and render tests with macOS's built-in JavaScriptCore (no Node needed).
- `tests/index.html` runs the same tests in a browser.
- `tests/ui.html` drives the real app in an iframe.
