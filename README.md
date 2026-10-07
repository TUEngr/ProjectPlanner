# Project Planner

A browser-based project planner with a task table, a Gantt chart with dependency arrows and the critical path, and a PERT network view.

This repository is a **template for team projects**. Each project gets its own copy of the repository, and the plan lives in that copy as ordinary files, so your team shares it, and keeps its history, with the same `git` it already uses. There is no server to run and no account to create beyond GitHub.

- [Quick start for a team](#quick-start-for-a-team)
- [How it works](#how-it-works)
- [Optional: a read-only website for your project](#optional-a-read-only-website-for-your-project)
- [Who can see and edit what](#who-can-see-and-edit-what)
- [Limits and good habits](#limits-and-good-habits)
- [Troubleshooting](#troubleshooting)
- [Using the planner on its own](#using-the-planner-on-its-own)
- [Development](#development)

## Quick start for a team

One person does steps 1 and 2. Everyone does steps 3 to 5.

1. **Create your project's repository.** Click **Use this template** at the top of this page, choose **Create a new repository**, and make it **Private** if the plan is not public.
   (Use *Use this template*, not *Fork*: a fork of a public repository cannot be made private.)
2. **Add your teammates.** In your new repository: **Settings → Collaborators → Add people**. Anyone with *Write* access can edit the plan.
3. **Open the project in a Codespace.** In your repository, click the green **Code** button, then **Codespaces → Create codespace on main**. The planner starts by itself; click **Open in Browser** in the notification that appears (port 8765).
4. **Edit.** Add tasks, dependencies and dates. Every change is saved to your Codespace's `data/` folder automatically.
5. **Press Sync** (top right) to share your work. It commits your changes with a message you can edit, pulls in your teammates' changes, and pushes. The status bar shows what is waiting, for example `main · 2 files to commit · 1 to pull`.

The first person to open the project names it in the Settings box that appears.

If you and a teammate changed the *same thing*, Sync shows a small dialog asking which version to keep. Everything that does not clash is merged for you.

## How it works

- **The plan is files in `data/`.** `data/plan.json` holds the settings; each task is its own file, `data/tasks/<id>.json`. Two people editing different tasks change different files, so git merges them without conflict. Your project's git history *is* its change log: `git log data/` shows who changed what, and `git revert` undoes a change.
- **No tokens, no sign-in inside the app.** In a Codespace, `git` already has your GitHub credentials. A small helper (`server/serve.py`, standard library only) saves your edits to disk and runs `git` for the Sync button. It listens only on its own machine and checks a one-time token on every request. The app never sees your credentials.
- **Your view is yours.** Which groups you have collapsed is remembered in your browser and is not written to the repository, so it never causes a diff.
- **Everyone is an owner.** Anyone with write access to the repository can edit the plan. GitHub, not the app, enforces that.

## Optional: a read-only website for your project

Each repository can publish its own site at `https://<owner>.github.io/<repository>/`, built by a workflow in `.github/workflows/pages.yml`. By default it publishes **only the planner itself, never your plan**.

**One-time setup** (three steps, about two minutes):

1. **Switch Pages on.** In your repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Run the workflow once.** Open the **Actions** tab, click **Publish site** in the list on the left, then **Run workflow** (keep the `main` branch selected) and wait for the green tick, about a minute. If the Actions tab asks you to enable workflows (new forks only), click **I understand my workflows, go ahead and enable them** first.
3. **Find your site.** Its address is shown at the end of the run (in the *deploy* job) and under **Settings → Pages**: `https://<owner>.github.io/<repository>/`.

After that, every push to `main` updates the site by itself. Step 2 is needed because the workflow only runs when something is pushed to `main`, so a site you switch on *afterwards* stays empty until you run it once. Until step 1 is done the workflow still finishes green and leaves a note saying what to switch on. Pages from a *private* repository needs a paid GitHub plan (GitHub Pro, which is included with the Student Developer Pack, Team or Enterprise).

**Publishing the plan is opt-in.** To publish a read-only view of the plan on that site, add a repository variable: **Settings → Secrets and variables → Actions → Variables → New repository variable**, name `PUBLISH_PLAN`, value `true`. Then run the workflow again (**Actions → Publish site → Run workflow**), or just push a change. The site then shows your plan, updated on every push to `main`, with an **Open in Codespaces to edit** button.

> **A Pages site is public on the internet, even when the repository is private.** Anyone with the link can read the published plan. Do not set `PUBLISH_PLAN` for a plan that must stay private. To stop publishing, delete the variable (or set it to anything other than `true`) and run the workflow again; the new build removes the plan from the site. Copies that someone already saved, or that a search engine or the Internet Archive already fetched, cannot be recalled.

## Who can see and edit what

| | Private repository, Pages off | Private repository, `PUBLISH_PLAN=true` |
|---|---|---|
| Plan files in the repository | Collaborators only | Collaborators only |
| The planner app | Collaborators (in a Codespace) | Public (the site) |
| The plan itself | Collaborators only | **Public (the site)** |
| Who can edit | Collaborators with Write access | Collaborators with Write access |

- **Leaving the team:** remove the person under **Settings → Collaborators**. They can no longer read the private repository or push to it. (They keep any copy they already cloned or downloaded, as with any shared project.)
- **No secrets are stored.** The workflow uses no secrets, and `PUBLISH_PLAN` is a plain variable.

## Limits and good habits

- **Sync often.** Unsynced edits exist only inside your Codespace. GitHub stops an idle Codespace after about 30 minutes (your work is kept) and **deletes it after about 30 days idle**, which would lose anything you never synced.
- **Codespaces time is limited.** Free accounts get a monthly allowance (students get more through the GitHub Student Developer Pack); a 2-core Codespace uses 2 core-hours per hour. Stop the Codespace when you are done: **Code → Codespaces → ⋯ → Stop**.
- **Protected branches.** Sync pushes the branch you are on. If `main` requires pull requests, work on a branch and open a pull request; Sync will not push around the rule.
- **One project per repository.** One plan, one Gantt chart. Make another repository from the template for another project.

## Troubleshooting

| You see | Do this |
|---|---|
| "Cannot reach the Project Planner helper" | The Codespace stopped or the helper restarted. Reopen the Codespace, then reload the page. |
| "The helper was restarted or this page is out of date" | Reload the page (the helper makes a new token each time it starts). |
| Nothing opened after the Codespace started | Open the **Ports** tab, find port 8765 and click the globe icon. Or run `bash server/start.sh` in the terminal, which prints the address. |
| The site shows a 404, or the example planner instead of your plan | Check that **Settings → Pages → Source** is *GitHub Actions*; that the latest **Publish site** run in the Actions tab is green (run it if there is none); and that `PUBLISH_PLAN` is exactly `true` and the workflow was run *after* you added it. Then hard-refresh the page. |
| To restart the helper | `bash server/start.sh restart`, then reload the page. |
| Sync says the push failed with "no upstream branch" | You are on a new branch. Run `git push -u origin HEAD` once, then press Sync. |
| "This conflict cannot be resolved in the app" | The conflict is in a file that is not plan data. Resolve it in the terminal (`git pull`, fix the files, `git commit`), then reload. |
| The status bar says "⚠ Not saved" | The helper cannot be reached. Do not close the page. Reopen the Codespace and reload. |

## Using the planner on its own

Without a repository (for example the example site, or opening `index.html` through any web server) the planner works entirely in your browser: no account and nothing is uploaded. Plans are stored in your browser (localStorage).

- **Save file / Open file** writes or reads a JSON file, for backups or for moving a plan between machines.
- **Share link** puts a compressed, read-only copy of the plan in the URL fragment (`#share=…`). The fragment is never sent to a server. Recipients can save their own editable copy.
- **Print** prints the Gantt chart, or saves it as a PDF. **Export PNG** saves the chart as an image.

Features:

- Tasks have a duration in working days, finish-to-start / start-to-start / finish-to-finish predecessors, % complete, an assignee, and notes.
- Tasks can be grouped into summary tasks (indent/outdent). A task with zero duration is a milestone.
- A working-day calendar: weekends are skipped, and each plan has its own holiday list.
- Start dates can be pinned manually. If a pinned date conflicts with a predecessor, the pin is kept and the task is flagged with ⚠.
- Critical path and total float, shown in red.
- Table, Gantt, PERT and split views, with undo/redo.

## Development

Plain ES modules with no build step. The helper is one Python file with no dependencies.

```sh
bash server/start.sh          # serve the app with the helper (repo mode); prints the address
python3 -m http.server 8765   # or serve it as a plain static site (standalone mode)
```

Tests:

```sh
./tests/run.sh                # JavaScript unit tests (macOS JavaScriptCore if present, else Node) and the Python tests
node tests/e2e-repo.cjs       # two people, two clones, two browsers: autosave, Sync, merging, conflicts
node tests/e2e-merge.cjs      # conflict resolution scenarios
node tests/e2e-pages.cjs      # the published read-only site
```

The end-to-end tests need [Playwright](https://playwright.dev) with Chromium; set `PLAYWRIGHT_MODULE` and `PW_CHROMIUM` if they are not found. `tests/index.html` runs the unit tests in a browser and `tests/ui.html` drives the real app in an iframe.

Layout: `js/` the app (`planfiles.js` and `merge.js` define how a plan is stored and merged, `repo.js` talks to the helper, `site.js` handles the published site), `server/` the helper, `.github/` the Pages workflow and its scripts, `data/` the plan (created on first use).

Bugs and feature requests for the planner itself: [issues](https://github.com/TUEngr/ProjectPlanner/issues).
