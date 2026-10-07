#!/usr/bin/env python3
"""Local helper for Project Planner (Codespaces / any clone).

Serves the app and exposes a tiny git API so the page can commit and push
plan data with the git credentials already present in this environment.
The browser never sees a token for GitHub. Standard library only.

    python3 server/serve.py [--port 8765] [--host 127.0.0.1]
"""
import argparse
import hmac
import json
import mimetypes
import os
import secrets
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = os.path.realpath(os.path.join(os.path.dirname(__file__), '..'))
STATIC_DIRS = ('css', 'js', 'data')
STATIC_FILES = ('index.html',)
TOKEN = secrets.token_urlsafe(32)
MAX_BODY = 64 * 1024
GIT_TIMEOUT = 60


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
    out = git('status', '--porcelain=v1', '--branch').stdout.splitlines()
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
    if not git('config', 'user.name').stdout.strip() or not git('config', 'user.email').stdout.strip():
        return 400, {'error': 'git user.name / user.email are not configured'}
    git('add', '-A', '--', 'data')
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
    """Map a URL path to a file under ROOT, or None. Only whitelisted locations."""
    rel = path.lstrip('/') or 'index.html'
    parts = rel.split('/')
    if rel not in STATIC_FILES and parts[0] not in STATIC_DIRS:
        return None
    full = os.path.realpath(os.path.join(ROOT, rel))
    if os.path.commonpath([full, ROOT]) != ROOT or not os.path.isfile(full):
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
        """Token required on every API call; POST also needs a same-origin Origin."""
        if not hmac.compare_digest(self.headers.get('X-PP-Token', ''), TOKEN):
            return False
        if self.command == 'POST':
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
            if path == '/api/git/status':
                return self.send_json(200, git_status())
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

    def do_POST(self):
        path = urlsplit(self.path).path
        if not path.startswith('/api/') or not self.authorized():
            return self.send_json(403, {'error': 'forbidden'})
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_BODY:
            return self.send_json(413, {'error': 'body too large'})
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return self.send_json(400, {'error': 'invalid JSON'})
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
