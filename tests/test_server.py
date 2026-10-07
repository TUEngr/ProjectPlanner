"""Tests for server/serve.py: auth, path safety, plan read/write, git sync.

    python3 -m unittest discover -s tests -p 'test_*.py'
"""
import contextlib
import http.client
import importlib.util
import json
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('serve', os.path.join(HERE, '..', 'server', 'serve.py'))
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)

PLAN = json.dumps({'format': 2, 'name': 'p'}) + '\n'
TASK = lambda n: json.dumps({'id': n, 'name': n}) + '\n'


def run(cwd, *args):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, check=True)


@contextlib.contextmanager
def root(path):
    old, serve.ROOT = serve.ROOT, os.path.realpath(path)
    try:
        yield
    finally:
        serve.ROOT = old


class ServerCase(unittest.TestCase):
    """A live server whose ROOT is a fresh temp directory."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.tmp.name)
        self._old_root, serve.ROOT = serve.ROOT, self.root
        os.makedirs(os.path.join(self.root, 'js'))
        os.makedirs(os.path.join(self.root, 'server'))
        for rel, text in (('index.html', '<html><head></head></html>'), ('js/app.js', '1'), ('server/serve.py', 'secret')):
            with open(os.path.join(self.root, rel), 'w') as f:
                f.write(text)
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), serve.Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        serve.ROOT = self._old_root
        self.tmp.cleanup()

    def call(self, method, path, body=None, token=True, origin='same', headers=None):
        h = {'Host': f'127.0.0.1:{self.port}'}
        if token is True:
            h['X-PP-Token'] = serve.TOKEN
        elif token:
            h['X-PP-Token'] = token
        if origin == 'same':
            if method in ('POST', 'PUT'):
                h['Origin'] = f'http://127.0.0.1:{self.port}'
        elif origin:
            h['Origin'] = origin
        h.update(headers or {})
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        raw = r.read()
        c.close()
        try:
            return r.status, json.loads(raw)
        except ValueError:
            return r.status, raw

    def get_plan(self):
        status, body = self.call('GET', '/api/plan')
        self.assertEqual(status, 200)
        return body

    def put(self, files, rev=None, **kw):
        return self.call('PUT', '/api/plan', {'baseRev': self.get_plan()['rev'] if rev is None else rev, 'files': files}, **kw)

    def on_disk(self, rel):
        full = os.path.join(self.root, rel)
        if not os.path.exists(full):
            return None
        with open(full) as f:
            return f.read()

    def data_listing(self):
        out = []
        for d, _, names in os.walk(os.path.join(self.root, 'data')):
            out += [os.path.relpath(os.path.join(d, n), self.root) for n in names]
        return sorted(out)


class AuthAndStatic(ServerCase):
    def test_api_requires_token(self):
        for method, path in (('GET', '/api/plan'), ('GET', '/api/git/status'), ('PUT', '/api/plan'), ('POST', '/api/git/sync')):
            for token in (False, 'wrong', 'é'):
                status, _ = self.call(method, path, {'x': 1}, token=token)
                self.assertEqual(status, 403, f'{method} {path} token={token!r}')

    def test_writes_require_same_origin(self):
        files = {'data/plan.json': PLAN}
        rev = self.get_plan()['rev']
        for origin in (None, '', 'http://evil.example', 'http://127.0.0.1:1', 'null'):
            status, _ = self.call('PUT', '/api/plan', {'baseRev': rev, 'files': files}, origin=origin)
            self.assertEqual(status, 403, f'origin={origin!r}')
            status, _ = self.call('POST', '/api/git/sync', {'message': 'x'}, origin=origin)
            self.assertEqual(status, 403, f'origin={origin!r}')
        self.assertEqual(self.data_listing(), [])

    def test_static_whitelist(self):
        self.assertEqual(self.call('GET', '/')[0], 200)
        self.assertEqual(self.call('GET', '/js/app.js')[0], 200)
        os.makedirs(os.path.join(self.root, 'data'))
        os.makedirs(os.path.join(self.root, '.git'))
        for rel, text in (('data/plan.json', '{}'), ('.git/config', '[core]')):
            with open(os.path.join(self.root, rel), 'w') as f:
                f.write(text)
        os.symlink(os.path.join(self.root, 'server', 'serve.py'), os.path.join(self.root, 'js', 'link.js'))
        for path in ('/server/serve.py', '/.git/config', '/data/plan.json', '/tests/test_server.py',
                     '/js/../server/serve.py', '/js/../.git/config', '/js/../data/plan.json', '/css/../js/../data/plan.json',
                     '/js/./../server/serve.py', '/js/%2e%2e/server/serve.py', '/%2e%2e/etc/passwd', '/js/link.js',
                     '/js\\..\\server\\serve.py', '/index.html/../server/serve.py'):
            status, body = self.call('GET', path, token=False)
            self.assertEqual(status, 404, f'{path} -> {status} {body!r}'[:120])

    def test_page_carries_the_token(self):
        _, page = self.call('GET', '/', token=False)
        self.assertIn(serve.TOKEN.encode(), page)

    def test_data_not_served_statically_even_when_present(self):
        self.assertEqual(self.put({'data/plan.json': PLAN})[0], 200)
        self.assertEqual(self.call('GET', '/data/plan.json', token=False)[0], 404)
        self.assertEqual(self.call('GET', '/data/plan.json')[0], 404)


class PlanReadWrite(ServerCase):
    def test_empty_then_create_then_read_back(self):
        empty = self.get_plan()
        self.assertEqual((empty['exists'], empty['files']), (False, {}))
        files = {'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1'), 'data/tasks/t2.json': TASK('t2')}
        status, res = self.put(files)
        self.assertEqual(status, 200, res)
        self.assertEqual(res['written'], sorted(files))
        back = self.get_plan()
        self.assertEqual((back['exists'], back['files']), (True, files))
        self.assertEqual(back['rev'], res['rev'])
        self.assertEqual(self.on_disk('data/tasks/t1.json'), TASK('t1'))

    def test_unchanged_save_writes_nothing(self):
        files = {'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1')}
        self.put(files)
        path = os.path.join(self.root, 'data/tasks/t1.json')
        before = os.stat(path).st_mtime_ns
        status, res = self.put(files)
        self.assertEqual((status, res['written'], res['deleted']), (200, [], []))
        self.assertEqual(os.stat(path).st_mtime_ns, before)

    def test_only_changed_files_are_written_and_missing_tasks_deleted(self):
        self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1'), 'data/tasks/t2.json': TASK('t2')})
        status, res = self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1x')})
        self.assertEqual((status, res['written'], res['deleted']), (200, ['data/tasks/t1.json'], ['data/tasks/t2.json']))
        self.assertEqual(self.data_listing(), ['data/plan.json', 'data/tasks/t1.json'])

    def test_unrelated_files_in_data_are_left_alone(self):
        os.makedirs(os.path.join(self.root, 'data/tasks'))
        for rel in ('data/notes.md', 'data/tasks/README.txt', 'data/tasks/UPPER.json'):
            with open(os.path.join(self.root, rel), 'w') as f:
                f.write('keep')
        self.put({'data/plan.json': PLAN})
        self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1')})
        for rel in ('data/notes.md', 'data/tasks/README.txt', 'data/tasks/UPPER.json'):
            self.assertEqual(self.on_disk(rel), 'keep', rel)
        self.assertEqual(sorted(self.get_plan()['files']), ['data/plan.json', 'data/tasks/t1.json'])

    def test_stale_base_rev_is_refused_and_nothing_written(self):
        self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1')})
        old = self.get_plan()['rev']
        with open(os.path.join(self.root, 'data/tasks/t1.json'), 'w') as f:  # e.g. a git pull changed it
            f.write(TASK('pulled'))
        status, res = self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('mine')}, rev=old)
        self.assertEqual(status, 409)
        self.assertEqual(res['rev'], self.get_plan()['rev'])
        self.assertEqual(self.on_disk('data/tasks/t1.json'), TASK('pulled'))
        self.assertEqual(self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('mine')}, rev=res['rev'])[0], 200)

    def test_rev_changes_with_content_and_with_file_set(self):
        self.put({'data/plan.json': PLAN})
        a = self.get_plan()['rev']
        self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1')})
        b = self.get_plan()['rev']
        self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1x')})
        self.assertEqual(len({a, b, self.get_plan()['rev']}), 3)

    def test_rejects_bad_requests_and_writes_nothing(self):
        good = {'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1')}
        cases = {
            'no plan.json': {'data/tasks/t1.json': TASK('t1')},
            'not json': {**good, 'data/tasks/t2.json': 'not json'},
            'merge markers': {**good, 'data/tasks/t2.json': '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n'},
            'json array': {**good, 'data/tasks/t2.json': '[1]'},
            'json scalar': {**good, 'data/tasks/t2.json': '5'},
            'non-string content': {**good, 'data/tasks/t2.json': {'a': 1}},
        }
        for name, files in cases.items():
            status, _ = self.put(files)
            self.assertEqual(status, 400, name)
        for body in (None, [], {'files': good}, {'baseRev': 'x'}, {'baseRev': 1, 'files': good}, {'baseRev': 'x', 'files': []}):
            self.assertEqual(self.call('PUT', '/api/plan', body)[0], 400, repr(body))
        self.assertEqual(self.call('PUT', '/api/plan', b'{nope')[0], 400)
        self.assertEqual(self.data_listing(), [])

    def test_path_traversal_and_odd_paths_are_refused(self):
        bad = [
            '../evil.json', 'data/../evil.json', 'data/tasks/../../evil.json', '/etc/passwd', 'data/tasks/../plan.json',
            'data/tasks/UPPER.json', 'data/tasks/a b.json', 'data/tasks/sub/t1.json', 'data/tasks/.json', 'data/tasks/t1.json/..',
            'data/plan.json/x', 'data/plan.json.pptmp', 'data/other.json', 'js/app.js', 'index.html', 'server/serve.py',
            'data\\tasks\\t1.json', 'data/tasks/t1.json\n', 'data/tasks/' + 'a' * 33 + '.json', 'data/tasks/t1.JSON',
        ]
        for rel in bad:
            status, res = self.put({'data/plan.json': PLAN, rel: TASK('x')})
            self.assertEqual(status, 400, f'{rel!r} -> {status} {res}')
        self.assertEqual(self.data_listing(), [])
        self.assertEqual(self.on_disk('js/app.js'), '1')
        self.assertEqual(self.on_disk('server/serve.py'), 'secret')
        self.assertFalse(os.path.exists(os.path.join(self.root, '..', 'evil.json')))

    def test_size_limits(self):
        big = json.dumps({'x': 'a' * (serve.MAX_PLAN_FILE + 10)})
        self.assertEqual(self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': big})[0], 413)
        many = {'data/plan.json': PLAN, **{f'data/tasks/t{i}.json': TASK(str(i)) for i in range(serve.MAX_PLAN_FILES + 1)}}
        self.assertEqual(self.put(many)[0], 413)
        h = {'Content-Length': str(serve.MAX_PLAN_BODY + 1)}
        self.assertEqual(self.call('PUT', '/api/plan', b'{}', headers=h)[0], 413)
        self.assertEqual(self.call('PUT', '/api/plan', b'{}', headers={'Content-Length': 'abc'})[0], 400)
        self.assertEqual(self.data_listing(), [])

    def test_symlinks_are_not_followed(self):
        outside = tempfile.TemporaryDirectory()
        try:
            os.symlink(outside.name, os.path.join(self.root, 'data'))
            status, _ = self.put({'data/plan.json': PLAN})
            self.assertEqual(status, 400)
            self.assertEqual(os.listdir(outside.name), [])
            os.unlink(os.path.join(self.root, 'data'))
            self.put({'data/plan.json': PLAN})
            os.makedirs(os.path.join(self.root, 'data/tasks'), exist_ok=True)
            with open(os.path.join(outside.name, 'secret.json'), 'w') as f:
                f.write('{"secret": 1}')
            os.symlink(os.path.join(outside.name, 'secret.json'), os.path.join(self.root, 'data/tasks/t9.json'))
            self.assertNotIn('data/tasks/t9.json', self.get_plan()['files'])   # not read through the link
            status, _ = self.put({'data/plan.json': PLAN, 'data/tasks/t9.json': TASK('t9')})
            self.assertEqual(status, 400)                                       # not written through it
            with open(os.path.join(outside.name, 'secret.json')) as f:
                self.assertEqual(f.read(), '{"secret": 1}')
        finally:
            outside.cleanup()

    def test_no_temp_files_left_behind(self):
        self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1')})
        self.put({'data/plan.json': PLAN, 'data/tasks/t1.json': TASK('t1x')})
        self.assertFalse([p for p in self.data_listing() if p.endswith(serve.TMP_SUFFIX)])

    def test_unicode_and_line_endings_survive_exactly(self):
        text = json.dumps({'name': 'Zażółć 日本語   "q"', 'notes': 'a\r\nb'}, ensure_ascii=False) + '\n'
        self.assertEqual(self.put({'data/plan.json': text})[0], 200)
        self.assertEqual(self.get_plan()['files']['data/plan.json'], text)
        with open(os.path.join(self.root, 'data/plan.json'), 'rb') as f:
            self.assertEqual(f.read(), text.encode())

    def test_concurrent_writers_cannot_both_win_from_the_same_base(self):
        self.put({'data/plan.json': PLAN})
        rev = self.get_plan()['rev']
        results = []

        def writer(n):
            results.append(self.put({'data/plan.json': PLAN, f'data/tasks/t{n}.json': TASK(str(n))}, rev=rev)[0])

        threads = [threading.Thread(target=writer, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(results), [200] + [409] * 7)
        self.assertEqual(len(self.get_plan()['files']), 2)


class GitSync(unittest.TestCase):
    """git_sync against a bare remote and two clones, driven directly."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = os.path.realpath(self.tmp.name)
        self.remote = os.path.join(base, 'remote.git')
        run(base, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
        self.a, self.b = os.path.join(base, 'a'), os.path.join(base, 'b')
        run(base, 'clone', '-q', 'remote.git', 'a')
        for who, d in (('A', self.a),):
            run(d, 'config', 'user.name', who)
            run(d, 'config', 'user.email', f'{who.lower()}@example.com')
        run(self.a, 'checkout', '-q', '-b', 'main')
        os.makedirs(os.path.join(self.a, 'data/tasks'))
        for rel, text in (('data/plan.json', PLAN), ('data/tasks/t1.json', TASK('t1'))):
            with open(os.path.join(self.a, rel), 'w') as f:
                f.write(text)
        run(self.a, 'add', '-A')
        run(self.a, 'commit', '-qm', 'init')
        run(self.a, 'push', '-q', '-u', 'origin', 'main')
        run(base, 'clone', '-q', 'remote.git', 'b')
        run(self.b, 'config', 'user.name', 'B')
        run(self.b, 'config', 'user.email', 'b@example.com')

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, clone, rel, text):
        with open(os.path.join(clone, rel), 'w') as f:
            f.write(text)

    def sync(self, clone, msg='update'):
        with root(clone):
            return serve.git_sync(msg)

    def test_commit_and_push_reaches_the_remote_with_the_users_identity(self):
        self.write(self.a, 'data/tasks/t2.json', TASK('t2'))
        status, body = self.sync(self.a, 'add t2')
        self.assertEqual(status, 200, body)
        self.assertEqual((body['ahead'], body['behind'], body['dirty']), (0, 0, []))
        log = run(self.remote, 'log', '-1', '--format=%an|%s').stdout.strip()
        self.assertEqual(log, 'A|add t2')

    def test_different_tasks_merge_without_conflict(self):
        self.write(self.a, 'data/tasks/t2.json', TASK('t2'))
        self.write(self.b, 'data/tasks/t3.json', TASK('t3'))
        self.assertEqual(self.sync(self.a, 'A')[0], 200)
        self.assertEqual(self.sync(self.b, 'B')[0], 200)
        self.assertEqual(self.sync(self.a, 'A again')[0], 200)
        for clone in (self.a, self.b):
            self.assertEqual(sorted(os.listdir(os.path.join(clone, 'data/tasks'))), ['t1.json', 't2.json', 't3.json'])

    def test_same_file_conflict_is_reported_and_the_merge_is_aborted(self):
        self.write(self.a, 'data/tasks/t1.json', TASK('A-version'))
        self.write(self.b, 'data/tasks/t1.json', TASK('B-version'))
        self.assertEqual(self.sync(self.a, 'A')[0], 200)
        status, body = self.sync(self.b, 'B')
        self.assertEqual((status, body['files']), (409, ['data/tasks/t1.json']))
        self.assertEqual(run(self.b, 'status', '--porcelain').stdout, '')              # no half-merged state
        with open(os.path.join(self.b, 'data/tasks/t1.json')) as f:
            self.assertNotIn('<<<<<<<', f.read())

    def test_temp_files_are_never_committed(self):
        self.write(self.a, 'data/tasks/t2.json', TASK('t2'))
        self.write(self.a, 'data/tasks/t9.json.abcd1234' + serve.TMP_SUFFIX, 'partial')
        self.assertEqual(self.sync(self.a, 'x')[0], 200)
        self.assertNotIn(serve.TMP_SUFFIX, run(self.a, 'ls-files').stdout)

    def test_only_data_is_staged(self):
        self.write(self.a, 'data/tasks/t2.json', TASK('t2'))
        self.write(self.a, 'notes.txt', 'unrelated local file')
        self.assertEqual(self.sync(self.a, 'x')[0], 200)
        self.assertNotIn('notes.txt', run(self.a, 'ls-files').stdout)

    def test_status_fetch_flag_controls_whether_the_remote_is_contacted(self):
        self.write(self.a, 'data/tasks/t2.json', TASK('t2'))
        self.assertEqual(self.sync(self.a, 'A adds t2')[0], 200)
        with root(self.b):
            self.assertEqual(serve.git_status(fetch=False)['behind'], 0)   # has not looked at the remote
            self.assertEqual(serve.git_status(fetch=True)['behind'], 1)    # now it has

    def test_status_lists_untracked_files_individually(self):
        os.makedirs(os.path.join(self.b, 'data/newdir/deeper'))
        self.write(self.b, 'data/newdir/deeper/x.json', '{}')
        self.write(self.b, 'data/newdir/y.json', '{}')
        with root(self.b):
            dirty = serve.git_status(fetch=False)['dirty']
        self.assertEqual(sorted(dirty), ['data/newdir/deeper/x.json', 'data/newdir/y.json'])

    def test_sync_with_nothing_to_commit_is_ok(self):
        status, body = self.sync(self.a, 'nothing')
        self.assertEqual((status, body['dirty']), (200, []))

    def test_missing_git_identity_is_a_clear_error(self):
        env_home = tempfile.TemporaryDirectory()
        old = {k: os.environ.get(k) for k in ('HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM')}
        try:
            os.environ.update(HOME=env_home.name, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
            run(self.b, 'config', '--unset', 'user.name')
            run(self.b, 'config', '--unset', 'user.email')
            status, body = self.sync(self.b, 'x')
            self.assertEqual(status, 400)
            self.assertIn('user.name', body['error'])
        finally:
            for k, v in old.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
            env_home.cleanup()


class SyncRequestValidation(ServerCase):
    def test_message_is_required_and_bounded(self):
        for body in ({}, {'message': ''}, {'message': '   '}, {'message': 5}, {'message': 'x' * 501}, [], None):
            self.assertEqual(self.call('POST', '/api/git/sync', body)[0], 400, repr(body)[:40])

    def test_status_endpoint_accepts_the_fetch_flag(self):
        for q in ('', '?fetch=0', '?fetch=1', '?fetch=junk'):
            status, body = self.call('GET', '/api/git/status' + q)
            self.assertIn(status, (200, 500), q)   # temp dir is not a git repo; the route must still be reached
        self.assertEqual(self.call('GET', '/api/git/status?fetch=0', token=False)[0], 403)

    def test_unknown_routes(self):
        self.assertEqual(self.call('GET', '/api/nope')[0], 404)
        self.assertEqual(self.call('POST', '/api/nope', {})[0], 404)
        self.assertEqual(self.call('PUT', '/api/nope', {})[0], 404)


if __name__ == '__main__':
    unittest.main()
