#!/usr/bin/env python3
"""Bundle the plan files into one JSON file for the read-only site.

    bundle-plan.py <repo-root> <output.json>

Reads data/plan.json and data/tasks/<id>.json with the same rules the helper
server uses for them (exact file names, JSON objects only, size limit, no
symlinks). Anything else in data/ is ignored. Exits non-zero, writing nothing,
if a plan file is not valid JSON, so a broken plan is never published.
Exits 3 (writing nothing) when the repo has no plan yet.
"""
import datetime
import json
import os
import re
import sys

PLAN = 'data/plan.json'
TASK_RE = re.compile(r'^data/tasks/[a-z0-9]{1,32}\.json$')
MAX_FILE = 256 * 1024


def read(root, rel):
    full = os.path.join(root, rel)
    if os.path.islink(full) or not os.path.isfile(full):
        return None
    if os.path.getsize(full) > MAX_FILE:
        raise SystemExit(f'{rel} is larger than {MAX_FILE} bytes')
    with open(full, encoding='utf-8', newline='') as f:
        text = f.read()
    try:
        ok = isinstance(json.loads(text), dict)
    except ValueError:
        ok = False
    if not ok:
        raise SystemExit(f'{rel} is not a JSON object (an unresolved merge conflict?)')
    return text


def bundle(root):
    plan = read(root, PLAN)
    if plan is None:
        return None
    files = {PLAN: plan}
    tasks_dir = os.path.join(root, 'data', 'tasks')
    if os.path.isdir(tasks_dir) and not os.path.islink(tasks_dir):
        for name in sorted(os.listdir(tasks_dir)):
            rel = f'data/tasks/{name}'
            if TASK_RE.fullmatch(rel):
                text = read(root, rel)
                if text is not None:
                    files[rel] = text
    return {
        'format': 1,
        'commit': os.environ.get('GITHUB_SHA', '')[:7],
        'generated': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'files': files,
    }


def main(argv):
    if len(argv) != 3:
        raise SystemExit(__doc__)
    result = bundle(argv[1])
    if result is None:
        print('No data/plan.json yet: nothing to publish.', file=sys.stderr)
        return 3
    os.makedirs(os.path.dirname(os.path.abspath(argv[2])), exist_ok=True)
    with open(argv[2], 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, separators=(',', ':'))
    print(f'Bundled {len(result["files"])} plan files.')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
