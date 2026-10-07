# Changelog

What changed in each version of [Project Planner](https://tuengr.github.io/ProjectPlanner/). Newest first. The version in use is shown at the bottom of the app's Help.

Version numbers: the middle number goes up for new features, the last number for fixes and smaller improvements.

## 1.10.0 — 2026-10-07
- Project repositories: a team can keep one shared plan in a git repository (make it from the GitHub template and open it in a Codespace). The plan is saved to the repository's `data` folder as it is edited, one small file per task, so different people's edits merge cleanly. A Sync button commits, pulls your teammates' changes and pushes. When two people change the same thing, a dialog asks which version to keep, and only for what really clashes. Collapsed groups stay in each person's own browser. See the README.
- Each project repository can publish its own site on GitHub Pages. The site shows the app only; the plan is published, read-only, only if the owner turns that on.
- Tasks now have short random ids, so two people adding tasks at the same time cannot collide. Plans and files from earlier versions open as before.

## 1.9.1 — 2026-10-06
- Near-critical tasks now default to 2 working days of float or less (was 5). Plans that already have a setting keep it; change it in Settings → Critical path.

## 1.9.0 — 2026-10-06
- Near-critical tasks: tasks with a little float (a number of working days set in Settings; 0 turns it off) are shown in orange in the table, Gantt chart, PERT diagram, and exports, and counted in the status bar.
- Help explains why the work before a pinned date can have float and not be red: when it finishes early, the pin sets the project end. Working Saturdays in a plan with a pinned final presentation was one way to see this.

## 1.8.1 — 2026-10-06
- Help now shows the version number and links to this changelog.

## 1.8.0 — 2026-10-06
- Table columns can be resized by dragging the edge of a column heading; double-click an edge to reset it. The Gantt chart's task-name column can be resized the same way.
- Widths are remembered in your browser for all plans, and the table and Gantt exports (PNG image and Print) follow them.
- Printing the table keeps dates and numbers readable: those columns always get the room they need, and the text columns share the rest of the page in their on-screen proportions.

## 1.7.1 — 2026-10-06
- On the Table tab, Export → PNG image and Export → Print now output the task table instead of the Gantt chart. Printed tables run across as many pages as needed, with the headings repeated.

## 1.7.0 — 2026-10-06
- New phone layout: a single bar with ☰ and the plan name. Everything else (status, editing tools, views, plans, settings, open, export, help) is in a slide-in menu. In landscape the split views are left out to give the chart the screen.
- Print moved into the Export menu.

## 1.6.0 — 2026-10-06
- Export menu: read-only link, JSON file, CSV file (the task table for Excel or Google Sheets), and PNG image.
- Open menu: JSON file, or CSV file to build a plan from a spreadsheet. If a CSV can't be read, you're offered a template CSV to fill in.

## 1.5.1 — 2026-10-05
- Phones: the button bars scroll sideways instead of wrapping, and the Gantt task-name column is narrower.

## 1.5.0 — 2026-10-05
- Settings: Include Gantt and Include PERT, to hide views a plan doesn't need.

## 1.4.1 — 2026-10-05
- Tooltips on warning ⚠, milestone ◆, and pin 📌 markers, Gantt bars, and PERT boxes now appear immediately, including on touch screens.

## 1.4.0 — 2026-10-05
- Settings: choose whether Saturdays and Sundays are working days.
- The zoom control moved to the top-right corner of the Gantt chart.

## 1.3.0 — 2026-10-02
- Collapse and expand summary groups by double-clicking them (or with the ▾/▸ triangle). Nested groups remember their own state.
- PERT tab: a network diagram of the tasks with the critical path in red.
- Views renamed and extended: Table, Gantt, PERT, Table/Gantt, Table/PERT.

## 1.2.0 — 2026-10-02
- Start-to-start (`SS`) and finish-to-finish (`FF`) dependencies, e.g. `5SS`, `7FF`.
- Export the Gantt chart as a PNG image for reports.
- Help covers every feature and links to GitHub issues for bug reports and feature requests.

## 1.1.0 — 2026-10-01
- Reorder tasks by dragging them in the Gantt chart or by the row number in the table.

## 1.0.0 — 2026-10-01
- First release: task table and Gantt chart with dependency arrows and the critical path in red; working-day calendar with holidays; summary tasks and milestones; pinned start dates; undo/redo; plans saved in the browser, JSON files, read-only share links, and printing.
