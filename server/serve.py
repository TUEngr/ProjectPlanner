#!/usr/bin/env python3
"""Local helper for Project Planner (Codespaces / any clone).

Serves the app and exposes a small API: read/write the plan files under data/
(GET/PUT /api/plan) and commit/push them with the git credentials already
present in this environment (/api/git/*). The browser never sees a token for
GitHub. Every /api call needs the per-launch token; writes also need a
same-origin Origin header. Standard library only.

    python3 server/serve.py [--port 8765] [--host 127.0.0.1]
"""
import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = os.path.realpath(os.path.join(os.path.dirname(__file__), '..'))
# data/ is deliberately not served statically: it is only reachable through the
# token-checked /api/plan.
STATIC_DIRS = ('css', 'js')
STATIC_FILES = ('index.html',)
TOKEN = secrets.token_urlsafe(32)
MAX_BODY = 64 * 1024          # small JSON bodies (git sync)
MAX_PLAN_BODY = 8 * 1024 * 1024
MAX_PLAN_FILE = 256 * 1024
MAX_PLAN_FILES = 3000
GIT_TIMEOUT = 60

PLAN_PATH = 'data/plan.json'
TASK_RE = re.compile(r'^data/tasks/[a-z0-9]{1,32}\.json$')
TMP_SUFFIX = '.pptmp'
LOCK = threading.Lock()       # plan writes and git sync never interleave


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(body.get('error', ''))
        self.status, self.body = status, body


# ---- Plan files (data/plan.json + data/tasks/<id>.json) ----

def plan_path_ok(rel):
    # fullmatch: `$` would also accept a trailing newline
    return rel == PLAN_PATH or bool(TASK_RE.fullmatch(rel))


def _plain_dir(rel):
    """ROOT/rel must exist as a real directory inside ROOT (no symlinks); else None."""
    full = os.path.join(ROOT, rel)
    cur = ROOT
    for part in rel.split('/'):
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            return None
    if not os.path.isdir(full) or os.path.commonpath([os.path.realpath(full), ROOT]) != ROOT:
        return None
    return full


def read_plan_files():
    files = {}
    data = _plain_dir('data')
    if data is None:
        return files
    candidates = [PLAN_PATH]
    tasks = _plain_dir('data/tasks')
    if tasks is not None:
        candidates += ['data/tasks/' + n for n in sorted(os.listdir(tasks))]
    for rel in candidates:
        full = os.path.join(ROOT, rel)
        if not plan_path_ok(rel) or os.path.islink(full) or not os.path.isfile(full):
            continue
        try:
            with open(full, encoding='utf-8', newline='') as f:
                files[rel] = f.read()
        except (OSError, UnicodeDecodeError):
            raise ApiError(500, {'error': f'cannot read {rel}'})
    return files


def plan_rev(files):
    """Fingerprint of the plan files: lets a writer prove it saw the current state."""
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(f'{rel}\0{len(files[rel].encode())}\0'.encode() + files[rel].encode() + b'\0')
    return h.hexdigest()


def get_plan():
    with LOCK:  # a consistent snapshot, never the middle of a save or a pull
        files = read_plan_files()
    return {'exists': PLAN_PATH in files, 'rev': plan_rev(files), 'files': files}


def put_plan(body):
    """Replace the plan with a full snapshot. Returns what changed.

    Refuses (nothing written) on: bad shape, a path outside the two allowed
    patterns, non-JSON content, symlinks, or a baseRev that is not the current
    state (someone pulled or wrote since the client last read).
    """
    if not isinstance(body, dict) or not isinstance(body.get('files'), dict) or not isinstance(body.get('baseRev'), str):
        raise ApiError(400, {'error': 'expected {baseRev, files}'})
    files = body['files']
    if len(files) > MAX_PLAN_FILES:
        raise ApiError(413, {'error': 'too many files'})
    if PLAN_PATH not in files:
        raise ApiError(400, {'error': f'{PLAN_PATH} is required (send a full snapshot)'})
    for rel, text in files.items():
        if not plan_path_ok(rel):
            raise ApiError(400, {'error': f'path not allowed: {rel}'})
        if not isinstance(text, str):
            raise ApiError(400, {'error': f'{rel}: content must be a string'})
        if len(text.encode()) > MAX_PLAN_FILE:
            raise ApiError(413, {'error': f'{rel}: file too large'})
        try:
            ok = isinstance(json.loads(text), dict)
        except ValueError:
            ok = False
        if not ok:
            raise ApiError(400, {'error': f'{rel}: must be a JSON object'})

    with LOCK:
        current = read_plan_files()
        if plan_rev(current) != body['baseRev']:
            raise ApiError(409, {'error': 'stale', 'rev': plan_rev(current)})
        changed = {rel: t for rel, t in files.items() if current.get(rel) != t}
        deleted = sorted(rel for rel in current if rel not in files)

        for d in ('data', 'data/tasks'):
            full = os.path.join(ROOT, d)
            if os.path.lexists(full) and _plain_dir(d) is None:
                raise ApiError(400, {'error': f'{d} must be a regular directory'})
            os.makedirs(full, exist_ok=True)
        for rel in changed:
            if os.path.islink(os.path.join(ROOT, rel)):
                raise ApiError(400, {'error': f'{rel} is a symlink'})

        staged = []
        try:
            for rel, text in changed.items():
                tmp = os.path.join(ROOT, rel) + '.' + uuid.uuid4().hex[:8] + TMP_SUFFIX
                with open(tmp, 'wb') as f:
                    f.write(text.encode())
                    f.flush()
                    os.fsync(f.fileno())
                staged.append((tmp, os.path.join(ROOT, rel)))
            for tmp, dest in staged:
                os.replace(tmp, dest)
            staged = []
            for rel in deleted:
                os.remove(os.path.join(ROOT, rel))
        except OSError as e:
            raise ApiError(500, {'error': f'write failed: {e.strerror}'})
        finally:
            for tmp, _ in staged:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        return {'rev': plan_rev(read_plan_files()), 'written': sorted(changed), 'deleted': deleted}


def git(*args, check=False):
    """Run git in the repo with a fixed argument list (never a shell string)."""
    return subprocess.run(
        ['git', *args], cwd=ROOT, capture_output=True, text=True,
        timeout=GIT_TIMEOUT, check=check,
        env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
    )


def git_status(fetch=True):
    if fetch:
        try:
            git('fetch', '--quiet')
        except subprocess.TimeoutExpired:
            pass
    out = git('status', '--porcelain=v1', '--branch', '-uall').stdout.splitlines()
    head = out[0] if out else ''
    ahead = behind = 0
    if '[' in head:
        for part in head[head.index('[') + 1:head.rindex(']')].split(','):
            part = part.strip()
            if part.startswith('ahead '):
                ahead = int(part[6:])
            elif part.startswith('behind '):
                behind = int(part[7:])
    branch = head[3:].split('...')[0] if head.startswith('## ') else ''
    return {
        'branch': branch,
        'ahead': ahead,
        'behind': behind,
        'dirty': [line[3:] for line in out[1:]],
        'user': git('config', 'user.name').stdout.strip(),
    }


def git_sync(message):
    """Commit data/, merge remote changes, push. Returns (http_status, body)."""
    with LOCK:
        return _git_sync(message)


def _git_sync(message):
    if not git('config', 'user.name').stdout.strip() or not git('config', 'user.email').stdout.strip():
        return 400, {'error': 'git user.name / user.email are not configured'}
    git('add', '-A', '--', 'data', f':(exclude)*{TMP_SUFFIX}')
    if git('diff', '--cached', '--quiet').returncode != 0:
        r = git('commit', '-m', message)
        if r.returncode != 0:
            return 500, {'error': 'commit failed', 'detail': r.stderr.strip()}
    r = git('pull', '--no-rebase', '--no-edit')
    if r.returncode != 0:
        conflicts = git('diff', '--name-only', '--diff-filter=U').stdout.split()
        if conflicts:
            git('merge', '--abort')
            return 409, {'error': 'merge conflict', 'files': conflicts}
        return 502, {'error': 'pull failed', 'detail': r.stderr.strip()}
    r = git('push')
    if r.returncode != 0:
        return 502, {'error': 'push failed', 'detail': r.stderr.strip()}
    return 200, git_status(fetch=False)


def resolve_static(path):
    """Map a URL path to a file under ROOT, or None. Only whitelisted locations.

    The whitelist is applied to the *resolved* path, so `..` segments and
    symlinks cannot reach anything outside index.html, css/ and js/.
    """
    rel = path.lstrip('/') or 'index.html'
    if '\\' in rel or '\0' in rel:
        return None
    full = os.path.realpath(os.path.join(ROOT, rel))
    if os.path.commonpath([full, ROOT]) != ROOT or not os.path.isfile(full):
        return None
    real_rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
    if real_rel not in STATIC_FILES and real_rel.split('/')[0] not in STATIC_DIRS:
        return None
    return full


class Handler(BaseHTTPRequestHandler):
    server_version = 'ProjectPlanner'

    def log_message(self, fmt, *args):
        pass

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        """Token required on every API call; writes also need a same-origin Origin."""
        if not hmac.compare_digest(self.headers.get('X-PP-Token', '').encode(), TOKEN.encode()):
            return False
        if self.command in ('POST', 'PUT'):
            origin = self.headers.get('Origin', '')
            host = self.headers.get('Host', '')
            if not origin or urlsplit(origin).netloc != host:
                return False
        return True

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith('/api/'):
            if not self.authorized():
                return self.send_json(403, {'error': 'forbidden'})
            try:
                if path == '/api/plan':
                    return self.send_json(200, get_plan())
                if path == '/api/git/status':
                    # ?fetch=0 skips the network call: cheap local counts only
                    query = parse_qs(urlsplit(self.path).query)
                    return self.send_json(200, git_status(fetch=query.get('fetch') != ['0']))
            except ApiError as e:
                return self.send_json(e.status, e.body)
            return self.send_json(404, {'error': 'not found'})
        full = resolve_static(path)
        if not full:
            self.send_response(404)
            self.end_headers()
            return
        with open(full, 'rb') as f:
            data = f.read()
        if full.endswith('index.html'):
            meta = f'<meta name="pp-token" content="{TOKEN}">'.encode()
            data = data.replace(b'</head>', meta + b'</head>', 1)
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(full)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def read_json_body(self, limit):
        """Parsed JSON body, or None after sending the error response."""
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            self.send_json(400, {'error': 'bad Content-Length'})
            return None
        if length < 0 or length > limit:
            self.send_json(413, {'error': 'body too large'})
            return None
        try:
            return json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            self.send_json(400, {'error': 'invalid JSON'})
            return None

    def do_PUT(self):
        path = urlsplit(self.path).path
        if not path.startswith('/api/') or not self.authorized():
            return self.send_json(403, {'error': 'forbidden'})
        if path != '/api/plan':
            return self.send_json(404, {'error': 'not found'})
        body = self.read_json_body(MAX_PLAN_BODY)
        if body is None:
            return
        try:
            return self.send_json(200, put_plan(body))
        except ApiError as e:
            return self.send_json(e.status, e.body)

    def do_POST(self):
        path = urlsplit(self.path).path
        if not path.startswith('/api/') or not self.authorized():
            return self.send_json(403, {'error': 'forbidden'})
        body = self.read_json_body(MAX_BODY)
        if body is None:
            return
        if path == '/api/git/sync':
            message = body.get('message') if isinstance(body, dict) else None
            if not isinstance(message, str) or not message.strip() or len(message) > 500:
                return self.send_json(400, {'error': 'message required (1-500 chars)'})
            status, result = git_sync(message.strip())
            return self.send_json(status, result)
        return self.send_json(404, {'error': 'not found'})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8765)
    args = ap.parse_args()
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        raise SystemExit(f'Cannot listen on port {args.port} ({e.strerror}). '
                         'Another copy is probably running; use: bash server/start.sh restart')
    print(f'Project Planner on http://{args.host}:{args.port}')
    server.serve_forever()


if __name__ == '__main__':
    main()
