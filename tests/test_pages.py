"""Tests for the GitHub Pages publishing scripts and workflow (.github/)."""
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

import yaml

REPO = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
TASK = lambda n: json.dumps({'id': n, 'name': n}) + '\n'


def make_repo(tmp, plan=True, tasks=('t1', 't2'), extra=None):
    """A minimal repo layout to run the scripts against, so tests never depend on this repo's data/."""
    root = os.path.join(tmp, 'repo')
    os.makedirs(os.path.join(root, '.github', 'scripts'))
    for name in os.listdir(os.path.join(REPO, '.github', 'scripts')):
        shutil.copy(os.path.join(REPO, '.github', 'scripts', name), os.path.join(root, '.github', 'scripts', name))
    shutil.copy(os.path.join(REPO, 'index.html'), root)
    for d in ('css', 'js'):
        shutil.copytree(os.path.join(REPO, d), os.path.join(root, d))
    for d in ('server', 'tests', '.devcontainer'):
        os.makedirs(os.path.join(root, d))
        with open(os.path.join(root, d, 'secret.txt'), 'w') as f:
            f.write('not for the site')
    with open(os.path.join(root, 'README.md'), 'w') as f:
        f.write('readme')
    if plan:
        os.makedirs(os.path.join(root, 'data', 'tasks'))
        with open(os.path.join(root, 'data', 'plan.json'), 'w') as f:
            f.write(json.dumps({'id': 'p', 'name': 'Secret project'}) + '\n')
        for t in tasks:
            with open(os.path.join(root, 'data', 'tasks', t + '.json'), 'w') as f:
                f.write(TASK(t))
    for rel, text in (extra or {}).items():
        full = os.path.join(root, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'w') as f:
            f.write(text)
    return root


def listing(path):
    return sorted(os.path.relpath(os.path.join(d, n), path) for d, _, names in os.walk(path) for n in names)


def build(root, out, **env):
    e = {k: v for k, v in os.environ.items() if k not in ('PUBLISH_PLAN', 'GITHUB_REPOSITORY', 'GITHUB_SHA')}
    e.update(env)
    return subprocess.run(['bash', os.path.join(root, '.github', 'scripts', 'build-site.sh'), out], capture_output=True, text=True, env=e)


class BuildSite(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = make_repo(self.tmp.name)
        self.out = os.path.join(self.tmp.name, '_site')

    def tearDown(self):
        self.tmp.cleanup()

    def test_publishes_only_the_app_by_default(self):
        r = build(self.root, self.out)
        self.assertEqual(r.returncode, 0, r.stderr)
        files = listing(self.out)
        self.assertIn('index.html', files)
        self.assertIn('.nojekyll', files)
        self.assertTrue(any(f.startswith('js/') for f in files) and any(f.startswith('css/') for f in files))
        for forbidden in ('data', 'server', 'tests', '.devcontainer', '.github', 'README.md', '.git'):
            self.assertFalse([f for f in files if f == forbidden or f.startswith(forbidden + '/')], f'{forbidden} was published')
        self.assertNotIn('Secret project', ''.join(open(os.path.join(self.out, f), errors='ignore').read() for f in files))
        self.assertIn('NOT published', r.stdout)

    def test_plan_is_published_only_when_publish_plan_is_exactly_true(self):
        for value in ('', 'false', 'yes', '1', 'TRUE', ' true', 'true '):
            r = build(self.root, self.out, PUBLISH_PLAN=value)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertFalse(os.path.exists(os.path.join(self.out, 'data')), f'published for PUBLISH_PLAN={value!r}')
            with open(os.path.join(self.out, 'index.html')) as f:
                self.assertFalse('pp-bundle' in f.read(), f'page marked for PUBLISH_PLAN={value!r}')

    def test_publish_plan_true_bundles_exactly_the_plan_files(self):
        with open(os.path.join(self.root, 'data', 'notes.md'), 'w') as f:
            f.write('private notes')
        with open(os.path.join(self.root, 'data', 'tasks', 'UPPER.json'), 'w') as f:
            f.write('{}')
        r = build(self.root, self.out, PUBLISH_PLAN='true', GITHUB_SHA='abcdef1234567890')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(listing(os.path.join(self.out, 'data')), ['bundle.json'])
        with open(os.path.join(self.out, 'data', 'bundle.json')) as f:
            b = json.load(f)
        self.assertEqual(sorted(b['files']), ['data/plan.json', 'data/tasks/t1.json', 'data/tasks/t2.json'])
        self.assertEqual((b['format'], b['commit']), (1, 'abcdef1'))
        self.assertEqual(b['files']['data/tasks/t1.json'], TASK('t1'))
        self.assertIn('public', r.stdout)
        with open(os.path.join(self.out, 'index.html')) as f:
            self.assertEqual(f.read().count('<meta name="pp-bundle" content="data/bundle.json">'), 1, 'page is not marked as having a bundle')

    def test_publish_plan_true_with_no_plan_yet_publishes_the_app_with_a_warning(self):
        shutil.rmtree(os.path.join(self.root, 'data'))
        r = build(self.root, self.out, PUBLISH_PLAN='true')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('No plan to publish', r.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.out, 'data')))
        with open(os.path.join(self.out, 'index.html')) as f:
            self.assertFalse('pp-bundle' in f.read(), 'marked as having a bundle that does not exist')

    def test_a_broken_plan_file_fails_the_build_instead_of_publishing(self):
        with open(os.path.join(self.root, 'data', 'tasks', 't1.json'), 'w') as f:
            f.write('<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n')
        r = build(self.root, self.out, PUBLISH_PLAN='true')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('t1.json', r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.out, 'data', 'bundle.json')))

    def test_repository_meta_is_added_once_and_only_for_a_plain_owner_slash_name(self):
        r = build(self.root, self.out, GITHUB_REPOSITORY='Tudre/Project-Planner.v2')
        self.assertEqual(r.returncode, 0, r.stderr)
        html = open(os.path.join(self.out, 'index.html')).read()
        self.assertEqual(html.count('name="pp-repo"'), 1)
        self.assertIn('<meta name="pp-repo" content="Tudre/Project-Planner.v2">', html)
        original = open(os.path.join(self.root, 'index.html')).read()
        self.assertEqual(html.replace('  <meta name="pp-repo" content="Tudre/Project-Planner.v2">\n', ''), original, 'nothing else changed')

    def test_a_hostile_repository_name_is_never_written_into_the_page(self):
        for slug in ('a/b"><script>alert(1)</script>', 'a/b#c', 'a b/c', 'x', 'a/b/c', '../..', 'a/b\nc/d', '&/&', 'a/.', 'a/..', '-a/b', '.a/b', '/b', 'a/'):
            r = build(self.root, self.out, GITHUB_REPOSITORY=slug)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(os.path.join(self.out, 'index.html')) as f:
                self.assertFalse('pp-repo' in f.read(), f'slug {slug!r} was written into the page')

    def test_rebuilding_replaces_the_old_output(self):
        build(self.root, self.out, PUBLISH_PLAN='true')
        self.assertTrue(os.path.exists(os.path.join(self.out, 'data', 'bundle.json')))
        build(self.root, self.out)
        self.assertFalse(os.path.exists(os.path.join(self.out, 'data')), 'a stale bundle survived a rebuild without PUBLISH_PLAN')


class BundlePlan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = make_repo(self.tmp.name)
        self.out = os.path.join(self.tmp.name, 'o', 'bundle.json')
        self.script = os.path.join(self.root, '.github', 'scripts', 'bundle-plan.py')

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self):
        return subprocess.run(['python3', self.script, self.root, self.out], capture_output=True, text=True)

    def test_symlinks_and_oversized_files_are_not_followed_or_accepted(self):
        outside = os.path.join(self.tmp.name, 'outside.json')
        with open(outside, 'w') as f:
            f.write('{"secret": 1}')
        os.symlink(outside, os.path.join(self.root, 'data', 'tasks', 'link.json'))
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out) as f:
            self.assertNotIn('data/tasks/link.json', json.load(f)['files'])
        with open(os.path.join(self.root, 'data', 'tasks', 'big.json'), 'w') as f:
            f.write(json.dumps({'x': 'a' * 300000}))
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('big.json', r.stderr)

    def test_non_object_json_is_rejected(self):
        for text in ('[1]', '5', 'null', '"s"', ''):
            with open(os.path.join(self.root, 'data', 'tasks', 't1.json'), 'w') as f:
                f.write(text)
            r = self.run_script()
            self.assertNotEqual(r.returncode, 0, text)
            self.assertFalse(os.path.exists(self.out))

    def test_symlinked_plan_json_counts_as_no_plan(self):
        os.remove(os.path.join(self.root, 'data', 'plan.json'))
        outside = os.path.join(self.tmp.name, 'p.json')
        with open(outside, 'w') as f:
            f.write('{}')
        os.symlink(outside, os.path.join(self.root, 'data', 'plan.json'))
        self.assertEqual(self.run_script().returncode, 3)
        self.assertFalse(os.path.exists(self.out))

    def test_output_is_deterministic_apart_from_the_timestamp(self):
        self.run_script()
        a = json.load(open(self.out))
        self.run_script()
        b = json.load(open(self.out))
        a.pop('generated'); b.pop('generated')
        self.assertEqual(a, b)
        self.assertEqual(list(a['files']), sorted(a['files'], key=lambda k: (k != 'data/plan.json', k)))


class PagesStatus(unittest.TestCase):
    """pages-status.sh against a fake `gh`."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bin = os.path.join(self.tmp.name, 'bin')
        os.makedirs(self.bin)
        gh = os.path.join(self.bin, 'gh')
        with open(gh, 'w') as f:
            f.write('#!/bin/sh\necho "$@" > "$FAKE_GH_LOG"\n[ -n "$FAKE_GH_STDERR" ] && echo "$FAKE_GH_STDERR" >&2\n[ -n "$FAKE_GH_STDOUT" ] && echo "$FAKE_GH_STDOUT"\nexit "${FAKE_GH_RC:-0}"\n')
        os.chmod(gh, os.stat(gh).st_mode | stat.S_IEXEC)

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, stdout='', stderr='', rc=0):
        out = os.path.join(self.tmp.name, 'output')
        open(out, 'w').close()
        env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ['PATH'], GITHUB_OUTPUT=out, GITHUB_REPOSITORY='o/r',
                   FAKE_GH_STDOUT=stdout, FAKE_GH_STDERR=stderr, FAKE_GH_RC=str(rc), FAKE_GH_LOG=os.path.join(self.tmp.name, 'log'))
        r = subprocess.run(['bash', os.path.join(REPO, '.github', 'scripts', 'pages-status.sh')], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(out) as f_out, open(env['FAKE_GH_LOG']) as f_log:
            return f_out.read().strip(), r.stdout, f_log.read().strip()

    def test_enabled_with_the_actions_source(self):
        out, stdout, log = self.run_script(stdout='workflow')
        self.assertEqual(out, 'enabled=true')
        self.assertIn('repos/o/r/pages', log)

    def test_a_branch_source_is_not_deployable_and_says_how_to_fix_it(self):
        out, stdout, _ = self.run_script(stdout='legacy')
        self.assertEqual(out, 'enabled=false')
        self.assertIn('::notice', stdout)
        self.assertIn('GitHub Actions', stdout)

    def test_not_enabled_yet_is_a_green_run_with_instructions(self):
        for err in ('gh: Not Found (HTTP 404)', 'HTTP 404: Not Found'):
            out, stdout, _ = self.run_script(stderr=err, rc=1)
            self.assertEqual(out, 'enabled=false', err)
            self.assertIn('Settings > Pages', stdout)

    def test_when_unsure_it_tries_to_deploy_and_warns(self):
        out, stdout, _ = self.run_script(stderr='gh: Resource not accessible by integration (HTTP 403)', rc=1)
        self.assertEqual(out, 'enabled=true')
        self.assertIn('::warning', stdout)

    def test_missing_repository_name_is_an_error(self):
        env = {k: v for k, v in os.environ.items() if k != 'GITHUB_REPOSITORY'}
        r = subprocess.run(['bash', os.path.join(REPO, '.github', 'scripts', 'pages-status.sh')], capture_output=True, text=True, env=env)
        self.assertNotEqual(r.returncode, 0)


class WorkflowFile(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(REPO, '.github', 'workflows', 'pages.yml')) as f:
            self.text = f.read()
        self.wf = yaml.safe_load(self.text)
        self.on = self.wf.get('on', self.wf.get(True))   # YAML reads a bare `on` as the boolean True

    def test_triggers_and_permissions_are_minimal(self):
        self.assertEqual(sorted(self.on), ['push', 'workflow_dispatch'])
        self.assertEqual(self.on['push']['branches'], ['main', 'master'])
        self.assertEqual(self.wf['permissions'], {'contents': 'read', 'pages': 'write', 'id-token': 'write'})
        for risky in ('pull_request_target', 'pull_request', 'issue_comment', 'workflow_run'):
            self.assertNotIn(risky, self.on)

    def test_no_secrets_and_no_untrusted_text_in_shell_steps(self):
        self.assertNotIn('secrets.', self.text)
        for job in self.wf['jobs'].values():
            for step in job['steps']:
                if 'run' in step:
                    self.assertNotIn('${{', step['run'], 'expression interpolated into a shell script')

    def test_deploy_waits_for_build_and_only_runs_when_pages_is_enabled(self):
        jobs = self.wf['jobs']
        self.assertEqual(jobs['deploy']['needs'], 'build')
        self.assertIn("needs.build.outputs.enabled == 'true'", jobs['deploy']['if'])
        for step in jobs['build']['steps']:
            if step.get('id') != 'check' and 'uses' not in step or step.get('uses', '').startswith('actions/upload'):
                self.assertIn("steps.check.outputs.enabled == 'true'", step.get('if', ''), step.get('name'))

    def test_publish_plan_is_read_from_the_repository_variable_only(self):
        assemble = next(s for s in self.wf['jobs']['build']['steps'] if s.get('name') == 'Assemble the site')
        self.assertEqual(assemble['env'], {'PUBLISH_PLAN': '${{ vars.PUBLISH_PLAN }}'})

    def test_actions_are_pinned_to_a_major_version(self):
        for job in self.wf['jobs'].values():
            for step in job['steps']:
                if 'uses' in step:
                    self.assertRegex(step['uses'], r'^actions/[a-z-]+@v\d+$')

    def test_scripts_the_workflow_calls_exist_and_are_executable_text(self):
        for rel in re.findall(r'bash (\.github/scripts/[\w.-]+)', self.text):
            self.assertTrue(os.path.isfile(os.path.join(REPO, rel)), rel)


if __name__ == '__main__':
    unittest.main()
