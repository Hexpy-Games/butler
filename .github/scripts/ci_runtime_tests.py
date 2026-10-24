"""Windows agent crate selection and green-only main baselines, run by test-ci-changes.py."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import ci_runtime_crates

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('runtime_changes', ROOT / 'ci-changes.py')
changes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changes)
CRATES = 'packages/butler-agent/rust/crates/'
WINDOWS = 'windows-preview-smoke.yml'
NONE = dict.fromkeys(['build', 'stub', 'hosted-build', 'release', 'hosted'], False)
# PRs never use the owner-PC runner unless labeled; main and labeled PRs do.
HOSTED = dict(NONE, **{'hosted-build': True, 'hosted': True})
NATIVE = dict(NONE, stub=True, hosted=True)


def select(paths, event='pull_request', changed=None, command=lambda *args: 'head', labels=()):
    with tempfile.TemporaryDirectory() as directory:
        env = dict(GITHUB_EVENT_NAME=event, GITHUB_REF='refs/heads/main', GITHUB_SHA='c' * 40,
                   GITHUB_REPOSITORY='owner/repo', GITHUB_RUN_ID='2',
                   GITHUB_OUTPUT=directory + '/output', GITHUB_STEP_SUMMARY=directory + '/summary')
        payload = ({'pull_request': {'number': 1, 'base': {'sha': 'base'},
                                    'labels': [{'name': label} for label in labels]}}
                   if event == 'pull_request' else {'before': 'b' * 40})
        with patch.dict(os.environ, env), patch.object(changes, 'command', side_effect=command), \
             patch.object(changes, 'changed', side_effect=changed or (lambda base: paths)), \
             patch.object(changes, 'previous', return_value=iter([])), \
             patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
            changes.select(payload, WINDOWS)
        output = dict(line.split('=', 1) for line in Path(env['GITHUB_OUTPUT']).read_text().splitlines())
    return json.loads(output['jobs']), json.loads(output['selection'])['base']


def main_runs(*runs):
    return json.dumps({'workflow_runs': [
        dict(id=run_id, head_sha=sha, status='completed', conclusion=conclusion, event='push',
             head_branch='main', path=f'.github/workflows/{WINDOWS}',
             head_repository={'full_name': 'owner/repo'}) for run_id, sha, conclusion in runs]})


class WindowsRuntimeSelection(unittest.TestCase):
    # test-category: pure-logic
    def test_host_platform_sandbox_and_file_io_changes_select_windows_smoke(self):
        for path in ['butler-agent/src/host/guided/command.rs', 'butler-platform/src/process.rs',
                     'butler-platform/src/command_sandbox/windows/mxc/prepare.rs',
                     'butler-platform/src/secure_fs/contained_read.rs',
                     'butler-runtime/src/capabilities/grep_files/search.rs']:
            with self.subTest(path=path):
                self.assertEqual(select([CRATES + path])[0], HOSTED)
                self.assertEqual(select([CRATES + path], labels=('ci:windows-native',))[0], NATIVE)
                self.assertEqual(select([CRATES + path], 'push')[0], NATIVE)

    # test-category: pure-logic
    def test_agent_dependency_graph_changes_select_windows_smoke(self):
        for path in [CRATES + 'butler-canon/src/lib.rs', CRATES + 'butler-agent-cli/src/main.rs',
                     'third_party/notify-windows-ledger/src/lib.rs',
                     'packages/butler-agent/rust/Cargo.lock']:
            with self.subTest(path=path):
                self.assertEqual(select([path])[0], HOSTED)

    # test-category: pure-logic
    def test_smoke_docs_ts_and_non_agent_crate_changes_skip_windows_smoke(self):
        for paths in [['tests/smoke/settings-release.smoke.ts'], ['README.md'],
                      [CRATES + 'butler-core/README.md', 'packages/butler-agent/rust/docs/layout.md'],
                      ['packages/butler-app/client/ui/src/app.tsx', 'packages/butler-i18n/src/locale.ts'],
                      [CRATES + 'butler-e2e/tests/e2e/turn.rs', CRATES + 'butler-test-support/src/lib.rs']]:
            with self.subTest(paths=paths):
                self.assertEqual(select(paths)[0], NONE)

    # test-category: pure-logic
    def test_closure_follows_linked_repository_crates_only(self):
        def package(name, path, source=None):
            return dict(id=name, name=name, source=source, manifest_path=f'/repo/{path}/Cargo.toml')
        kinds = lambda *values: [dict(kind=value) for value in values]
        metadata = dict(workspace_members=['butler-agent', 'tests'], packages=[
            package('butler-agent', 'cli'), package('host', 'host'), package('core', 'core'),
            package('build-helper', 'build'), package('tests', 'tests'),
            package('serde', 'registry/serde', 'registry+https://github.com/rust-lang/crates.io-index')],
            resolve=dict(nodes=[
                dict(id='butler-agent', deps=[dict(pkg='host', dep_kinds=kinds(None)),
                                              dict(pkg='tests', dep_kinds=kinds('dev'))]),
                dict(id='host', deps=[dict(pkg='core', dep_kinds=kinds('dev', None)),
                                      dict(pkg='build-helper', dep_kinds=kinds('build')),
                                      dict(pkg='serde', dep_kinds=kinds(None))]),
                dict(id='core', deps=[dict(pkg='host', dep_kinds=kinds(None))]),
                dict(id='build-helper', deps=[]), dict(id='tests', deps=[]), dict(id='serde', deps=[])]))
        self.assertEqual(ci_runtime_crates.closure(metadata, Path('/repo')),
                         ['build', 'cli', 'core', 'host'])

    # test-category: pure-logic
    def test_checked_in_crate_list_fails_when_the_cargo_graph_drifts(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / 'runtime-crates.json'
            graph = dict(agent='butler-agent', target='x86_64-pc-windows-msvc', crates=['a', 'b'])
            manifest.write_text(json.dumps(graph, indent=2) + '\n')
            with patch.object(ci_runtime_crates, 'MANIFEST', manifest):
                with patch.object(ci_runtime_crates, 'generate', return_value=graph):
                    self.assertEqual(ci_runtime_crates.main(['--check']), 0)
                with patch.object(ci_runtime_crates, 'generate', return_value=dict(graph, crates=['a', 'b', 'c'])):
                    self.assertIn('drifted from the Cargo graph', ci_runtime_crates.main(['--check']))
        # The real graph check runs where Cargo dependencies are already fetched.
        clippy = (ROOT.parent / 'workflows/rust-clippy.yml').read_text()
        self.assertIn('.github/scripts/ci_runtime_crates.py" --check', clippy)
        self.assertIn("'.github/scripts/ci_runtime_crates.py',", (ROOT / 'prepush.py').read_text())
        for crate in ci_runtime_crates.crates():
            self.assertTrue((ROOT.parents[1] / crate / 'Cargo.toml').is_file(), crate)


class SkippedIsNotPass(unittest.TestCase):
    # test-category: pure-logic
    def test_failed_main_run_never_becomes_the_selection_baseline(self):
        green, red = 'a' * 40, 'f' * 40
        platform = CRATES + 'butler-platform/src/secure_fs/contained_read.rs'
        smoke = 'tests/smoke/settings-release.smoke.ts'
        # The red commit changed the platform crate; this push changes only a smoke file.
        diffs = {green: [platform, smoke], red: [smoke]}
        for runs, base, selected in [
                ([(3, red, 'failure'), (2, green, 'success')], green, NATIVE),
                ([(3, red, 'cancelled'), (2, green, 'success')], green, NATIVE),
                ([(4, red, 'success'), (2, green, 'success')], red, NONE)]:
            with self.subTest(runs=runs):
                command = lambda *args: main_runs(*runs) if args[:2] == ('gh', 'api') else 'head'
                self.assertEqual(select([], 'push', lambda value: diffs[value], command), (selected, base))


if __name__ == '__main__':
    unittest.main()
