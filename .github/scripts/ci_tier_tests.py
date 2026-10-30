"""Approved CI coverage tiers, exercised by test-ci-changes.py."""
import importlib.util
import itertools
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('tier_changes', ROOT / 'ci-changes.py')
changes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changes)


def github_path_match(path, pattern):
    """GitHub path-filter subset used here: * excludes /, ** includes /.

    https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet
    """
    tokens = []
    for part in re.split(r'(\*\*/|\*\*|\*)', pattern):
        tokens.append({'**/': '(?:.*/)?', '**': '.*', '*': '[^/]*'}.get(part, re.escape(part)))
    return re.fullmatch(''.join(tokens), path) is not None


def selection(paths, event='pull_request', workflow='rust-quality.yml', labels=()):
    with tempfile.TemporaryDirectory() as directory:
        env = dict(GITHUB_EVENT_NAME=event, GITHUB_REF='refs/heads/main',
                   GITHUB_REPOSITORY='owner/repo', GITHUB_RUN_ID='2',
                   GITHUB_OUTPUT=directory + '/output', GITHUB_STEP_SUMMARY=directory + '/summary')
        payload = {'pull_request': {'number': 1, 'base': {'sha': 'base'},
                                   'labels': [{'name': label} for label in labels]}} if event == 'pull_request' else ({} if event == 'workflow_dispatch' else {'before': 'base'})
        with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='head'), \
             patch.object(changes, 'changed', return_value=paths), \
             patch.object(changes, 'main_base', return_value='base'), \
             patch.object(changes, 'previous', return_value=iter([])), \
             patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
            changes.select(payload, workflow)
        return dict(line.split('=', 1) for line in Path(env['GITHUB_OUTPUT']).read_text().splitlines())


class ApprovedTiers(unittest.TestCase):
    # test-category: pure-logic
    def test_every_pr_shape_selects_only_hosted_fast_lane(self):
        from ci_policy import PR_FAST_JOBS
        shapes = [
            ['packages/butler-agent/rust/crates/butler-core/src/lib.rs'],
            ['packages/butler-agent/rust/crates/butler-platform/src/lib.rs', 'Cargo.toml'],
            ['deploy/install.sh', 'VERSION'],
            ['packages/butler-app/client/ui/src/app.tsx'],
            ['.github/workflows/rust-quality.yml'],
        ]
        # Derive all orchestrators that publish selections; test policy ingress,
        # including unknown CI inputs (the fail-closed superset).
        workflows = [p.name for p in (ROOT.parent / 'workflows').glob('*.yml')
                     if "workflow: " + p.name in p.read_text()]
        self.assertIn('rust-quality.yml', workflows)
        for paths, workflow in itertools.product(shapes, workflows):
            outputs = selection(paths, workflow=workflow)
            selected = {name for name, enabled in json.loads(outputs['jobs']).items() if enabled}
            # Only Windows agent crate changes add the separate Windows smoke.
            agent = any(changes.windows_runtime(path, 'pull_request') for path in paths)
            allowed = (PR_FAST_JOBS if workflow == 'rust-quality.yml' else
                       {'hosted-build', 'hosted'} if workflow == 'windows-preview-smoke.yml' and agent else set())
            self.assertLessEqual(selected, allowed, (paths, workflow, selected))
            if workflow == 'rust-quality.yml':
                self.assertFalse(json.loads(outputs['parts'])['ui']['macos'])

    # test-category: pure-logic
    def test_packaging_and_arm64_destinations_and_gate(self):
        rust = 'packages/butler-agent/rust/crates/butler-core/src/lib.rs'
        exceptions = ['VERSION', 'deploy/install.sh', 'Cargo.toml',
                      'packages/butler-agent/rust/Cargo.lock',
                      'packages/butler-agent/rust/crates/butler-platform/src/lib.rs']
        moved = ['linux-native', 'linux-arm64-native', 'linux-package-x64',
                 'linux-package-arm64', 'install-x64', 'install-arm64']
        for event in ('pull_request', 'push'):
            for path in [rust] + exceptions:
                output = selection([path], event)
                jobs = json.loads(output['jobs'])
                for name in moved:
                    self.assertEqual(jobs[name], event != 'pull_request', (event, path, name))
                self.assertEqual(jobs['linux-arm64-archive'], event != 'pull_request' and output['rust'] == 'true')
                results = {'changes': {'result': 'success', 'outputs': output}}
                results.update({name: {'result': 'success' if enabled else 'skipped'} for name, enabled in jobs.items()})
                run = subprocess.run(['python3', str(ROOT / 'check-gate.py')],
                                     env=dict(os.environ, RESULTS=json.dumps(results)), capture_output=True, text=True)
                self.assertEqual(run.returncode, 0, run.stderr)
        outputs = dict.fromkeys(changes.GROUPS, 'true') | {'tier': 'integration'}
        self.assertTrue(all(changes.rust_jobs(outputs, 'push').values()))


    # test-category: pure-logic
    def test_windows_destinations_use_selected_jobs_and_hosted_clippy(self):
        workflow = 'windows-preview-smoke.yml'
        rust = 'packages/butler-agent/rust/crates/butler-core/src/lib.rs'
        windows = 'packages/butler-agent/rust/crates/butler-platform/src/process.rs'
        for event, paths, labels, native in [
            ('pull_request', [rust], (), 'hosted'),
            ('pull_request', [windows], (), 'hosted'),
            ('pull_request', ['packages/butler-agent/rust/crates/butler-core/src/windows/native.rs'], (), 'hosted'),
            ('pull_request', ['packages/butler-agent/rust/crates/butler-e2e/tests/e2e/new.rs'], (), False),
            ('pull_request', [rust], ('ci:windows-native',), True),
            ('pull_request', ['packages/butler-agent/rust/crates/butler-e2e/tests/e2e/new.rs'], ('ci:windows-native',), True),
            ('push', [rust], (), True), ('push', ['README.md'], (), False),
            ('workflow_dispatch', [], (), True),
        ]:
            output = selection(paths, event, workflow, labels)
            jobs = json.loads(output['jobs'])
            # 'hosted': GitHub-hosted build and shards; True: owner-PC native stub and shards.
            self.assertEqual(jobs, {'build': False, 'release': False, 'stub': native is True,
                                    'hosted-build': native == 'hosted', 'hosted': bool(native)})
            results = {'changes': {'result': 'success', 'outputs': output}}
            results.update({name: {'result': 'success' if enabled else 'skipped'} for name, enabled in jobs.items()})
            env = dict(os.environ, RESULTS=json.dumps(results), CHECK_GROUPS=json.dumps(dict.fromkeys(jobs, 'jobs')))
            run = subprocess.run(['python3', str(ROOT / 'ci-check-selected.py')], env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        integration = dict(package='true', windows='true', tier='integration')
        self.assertEqual(changes.windows_preview_jobs(integration, 'push'),
                         {'build': True, 'stub': True, 'hosted-build': False, 'release': True, 'hosted': True})
        source = (ROOT.parent / 'workflows' / workflow).read_text()
        self.assertIn('branches: [main,', source)
        self.assertIn('gh workflow run windows-preview-smoke.yml --ref <head-branch>', source)
        # Every required context remains in an unfiltered PR workflow.
        required = (ROOT.parent / 'workflows/rust-quality.yml').read_text()
        self.assertIn('  pull_request:\n', required)
        self.assertNotIn('paths:', required.split('  pull_request:')[1].split('  workflow_dispatch:')[0])
        self.assertIn('post-merge-ci gate', required)
        clippy = (ROOT.parent / 'workflows/rust-windows-check.yml').read_text()
        self.assertIn('runs-on: windows-latest', clippy)
        self.assertIn('cargo clippy --workspace --all-targets', clippy)
        self.assertIn('-- -D warnings', clippy)
        self.assertTrue(json.loads(selection([rust])['jobs'])['windows-check'])


    # test-category: pure-logic
    def test_macos_archive_and_workspace_follow_platform_paths(self):
        root = 'packages/butler-agent/rust/crates/'
        for path, on_pr in [(root + 'butler-core/src/lib.rs', False),
                            (root + 'butler-platform/src/lib.rs', True),
                            (root + 'butler-core/src/macos.rs', True),
                            (root + 'butler-core/src/darwin.rs', True),
                            ('deploy/macos-build.sh', False)]:
            for event in ('pull_request', 'push'):
                output = selection([path], event)
                jobs = json.loads(output['jobs'])
                for name in ('macos-archive', 'macos-tests'):
                    self.assertEqual(jobs[name], False if event == 'pull_request' else output['rust'] == 'true', (path, event))
                self.assertEqual(jobs['linux-tests'], event != 'pull_request' and output['rust'] == 'true')
        source = (ROOT.parent / 'workflows/rust-quality.yml').read_text()
        for name in ('macos-archive', 'macos-tests'):
            block = re.split(r'^  [\w-]+:', source.split('  ' + name + ':')[1], maxsplit=1, flags=re.M)[0]
            self.assertIn("fromJSON(needs.changes.outputs.jobs)['" + name + "']", block)


    # test-category: format-pin
    def test_bun_suite_moves_intact_and_keeps_macos_host_fixtures(self):
        source = (ROOT.parent / 'workflows/bun-unit.yml').read_text()
        fast, native = source.split('\n  macos-native:\n', 1)
        self.assertIn('runs-on: ubuntu-24.04', fast)
        self.assertIn('bun run test:unit:fast', fast)
        self.assertNotIn('continue-on-error', source)
        self.assertEqual(source.count('timeout-minutes: 20'), 2)
        self.assertIn('runs-on: macos-15', native)
        self.assertIn('bun test tests/unit/prepare-native-agent-script.test.ts', native)
        for path, expected in {
            'packages/butler-app/client/ui/src/app.tsx': False,
            'tests/unit/prepare-native-agent-script.test.ts': True,
            'tests/unit/run-fast-unit-tests.sh': True,
            'packages/butler-app/client/electron/scripts/prepare-native-agent.mjs': True,
            '.github/workflows/bun-unit.yml': True, 'bun.lock': True, 'bunfig.toml': True,
        }.items():
            self.assertEqual(json.loads(selection([path])['parts'])['ui']['macos'], False, path)
        # No other fast-unit file has a Darwin-only host guard.
        repository = ROOT.parents[1]
        guards = [p.name for p in (repository / 'tests/unit').glob('*.test.ts')
                  if re.search(r'process.platform [!=]== ["\']darwin["\']', p.read_text())]
        self.assertEqual(guards, ['prepare-native-agent-script.test.ts'])


    # test-category: format-pin
    def test_self_hosted_windows_jobs_reserve_the_release_lane(self):
        from ci_consumer_test_support import jobs
        dynamic = "${{ (startsWith(github.ref, 'refs/heads/release/') || startsWith(github.ref, 'refs/tags/')) && 'butler-win-release' || 'butler-win-shared' }}"
        expected = {
            ('e2e.yml', 'e2e-live'): 'butler-win-release',
            ('windows-installer.yml', 'build'): 'butler-win-release',
            ('release.yml', 'agent-windows-build'): 'butler-win-release',
            ('release.yml', 'app-windows'): 'butler-win-release',
            ('windows-preview-smoke.yml', 'build'): 'butler-win-release',
            ('windows-preview-smoke.yml', 'stub'): dynamic,
            ('windows-powershell-diagnostics.yml', 'diagnose-native'): dynamic,
            ('native-deps.yml', 'windows-self-hosted'): dynamic,
        }
        found = set()
        for workflow in (ROOT.parent / 'workflows').glob('*.yml'):
            for name, block in jobs(workflow.read_text()).items():
                runner = re.search(r'^    runs-on: (.+)$', block, re.M)
                if not runner or 'butler-win' not in runner[1]:
                    continue
                key = (workflow.name, name)
                found.add(key)
                self.assertIn(expected[key], runner[1], key)
                if workflow.name == 'release.yml':
                    self.assertIn("inputs.runner == 'hosted' && 'windows-latest'", runner[1])
        self.assertEqual(found, set(expected))
        plan = (ROOT.parent / 'actions/windows-runner-setup/README.md').read_text()
        self.assertIn('dedicated release and shared lanes', plan)
        self.assertIn('PR/main jobs use the shared lane', plan)
        config = (ROOT.parent / 'actionlint.yaml').read_text()
        for lane in ('butler-win-release', 'butler-win-shared'):
            self.assertIn(lane, config)

    # test-category: pure-logic
    def test_pr_packaging_covers_invoked_packagers(self):
        repository = ROOT.parents[1]
        sources = list((ROOT.parent / 'workflows').glob('*.yml'))
        sources += list((ROOT.parent / 'actions').glob('*/action.yml'))
        invoked = {name for source in sources for name in re.findall(
            r'/(package-[\w-]+\.py|release-standalone-agent\.py)', source.read_text())}
        self.assertTrue(invoked)
        for name in invoked:
            path = 'packages/butler-agent/rust/scripts/' + name
            self.assertTrue((repository / path).is_file(), path)
            output = selection([path])
            for group in ('package', 'install', 'linux-package'):
                self.assertEqual(output[group], 'true', (path, group))
        # New scripts inherit coverage without another hand-maintained filename.
        self.assertEqual(selection(['packages/butler-agent/rust/scripts/new-tool.py'])['package'], 'true')

    # test-category: pure-logic
    def test_windows_trigger_and_selector_match_concrete_paths(self):
        source = (ROOT.parent / 'workflows/windows-preview-smoke.yml').read_text()
        self.assertIn('  pull_request:\n    types: [opened, synchronize, reopened]\n', source)
        patterns = changes.WINDOWS
        cases = {
            'windows.rs': True, 'windows/nested/input.rs': True,
            'src/windows.rs': True, 'src/windows/nested/input.rs': True,
            'src/not-windows.rs': False, 'src/windows_extra/deep/file.rs': True,
            '.github/actions/rust-agent-setup/action.yml': True,
            '.github/actions/rust-agent-setup/nested/config.json': True,
            '.github/actions/rust-agent-setup-other/action.yml': False,
            '.github/actions/windows-runner-setup/action.yml': True,
            '.github/actions/windows-runner-setup/nested/file.ps1': True,
            '.github/workflows/rust-windows-check.yml': True,
            '.github/scripts/test-windows-ci-safety.py': True,
            '.github/scripts/nested/windows-check.py': True,
            'deploy/windows-build.ps1': True, 'deploy/windows/nested/file.ps1': True,
            'packages/butler-agent/rust/crates/butler-platform/src/lib.rs': True,
            'packages/butler-agent/rust/crates/butler-e2e/tests/e2e/windows_case.rs': True,
            'packages/butler-agent/rust/crates/butler-core/src/lib.rs': False,
            'README.md': False,
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                github = changes.matches(path, patterns)
                self.assertEqual(github, expected)
                self.assertEqual(changes.windows_native(path), github)

    # test-category: pure-logic
    def test_main_api_baseline_skips_cancelled_and_failed_runs(self):
        def run(number, conclusion, **extra):
            return dict(id=number, status='completed', conclusion=conclusion, event='push',
                        head_branch='main', path='.github/workflows/rust-quality.yml',
                        head_repository={'full_name': 'owner/repo'},
                        head_sha=str(number) * 40) | extra
        # Fixture response includes a superseded merge, an unfinished run and
        # unrelated runs; only a success proves coverage, so a failure is never a baseline.
        fixture = dict(workflow_runs=[run(9, 'cancelled'), run(8, None, status='in_progress'),
                                      run(7, 'success', head_branch='other'),
                                      run(6, 'success', head_repository={'full_name': 'fork/repo'}),
                                      run(5, 'failure'), run(4, 'success')])
        def command(*args):
            return json.dumps(fixture) if args[0] == 'gh' else ''
        env = dict(GITHUB_REPOSITORY='owner/repo', GITHUB_EVENT_NAME='push',
                   GITHUB_REF='refs/heads/main', GITHUB_SHA='a' * 40)
        with patch.dict(os.environ, env), patch.object(changes, 'command', side_effect=command) as calls:
            self.assertEqual(changes.selection_base({'before': '9' * 40}, 'rust-quality.yml'), '4' * 40)
            self.assertIn('branch=main&event=push&status=completed', calls.call_args_list[0].args[2])
            self.assertEqual(calls.call_args_list[-1].args,
                             ('git', 'merge-base', '--is-ancestor', '4' * 40, 'HEAD'))
            with tempfile.TemporaryDirectory() as directory:
                outputs = dict(GITHUB_OUTPUT=directory + '/output',
                               GITHUB_STEP_SUMMARY=directory + '/summary', GITHUB_RUN_ID='10')
                paths = ['packages/butler-agent/rust/crates/butler-core/src/lib.rs']
                with patch.dict(os.environ, outputs), \
                     patch.object(changes, 'changed', return_value=paths) as diff, \
                     patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
                    changes.select({'before': '9' * 40}, 'rust-quality.yml')
                diff.assert_called_once_with('4' * 40)
                output = dict(line.split('=', 1) for line in Path(outputs['GITHUB_OUTPUT']).read_text().splitlines())
                jobs = json.loads(output['jobs'])
                for job in ('linux-native', 'macos-archive', 'macos-tests', 'windows-check'):
                    self.assertTrue(jobs[job], job)
            fixture['workflow_runs'][4]['conclusion'] = 'success'
            self.assertEqual(changes.main_base('rust-quality.yml'), '5' * 40)

    # test-category: pure-logic
    def test_windows_main_includes_rust_merge_after_pending_smoke_cancelled(self):
        workflow = 'windows-preview-smoke.yml'
        a, b, c = (letter * 40 for letter in 'abc')
        def run(number, sha, workflow, conclusion):
            return dict(id=number, status='completed', conclusion=conclusion,
                        event='push', head_branch='main', head_sha=sha,
                        path=f'.github/workflows/{workflow}',
                        head_repository={'full_name': 'owner/repo'})
        rust_b = run(4, b, 'rust-quality.yml', 'success')
        # B changed Rust, but its pending Windows smoke was cancelled. Rust
        # Quality finished B; the next push C changes only UI. A covered Windows.
        windows_runs = [rust_b, run(3, b, workflow, 'cancelled'),
                        run(2, a, workflow, 'success')]
        queries = []
        def command(*args):
            if args[0] == 'gh':
                queries.append(args[2])
                runs = windows_runs if f'/workflows/{workflow}/runs?' in args[2] else [rust_b]
                return json.dumps({'workflow_runs': runs})
            return c
        ui = 'packages/butler-app/client/ui/src/app.tsx'
        rust = 'packages/butler-agent/rust/crates/butler-core/src/lib.rs'
        with tempfile.TemporaryDirectory() as directory:
            env = dict(GITHUB_EVENT_NAME='push', GITHUB_REF='refs/heads/main',
                       GITHUB_REPOSITORY='owner/repo', GITHUB_SHA=c, GITHUB_RUN_ID='5',
                       GITHUB_OUTPUT=directory + '/output', GITHUB_STEP_SUMMARY=directory + '/summary')
            with patch.dict(os.environ, env), \
                 patch.object(changes, 'command', side_effect=command), \
                 patch.object(changes, 'changed', side_effect=lambda base: [rust, ui] if base == a else [ui]) as diff, \
                 patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
                changes.select({'before': b}, workflow)
            diff.assert_called_once_with(a)
            self.assertEqual(len(queries), 1)
            self.assertIn(f'/workflows/{workflow}/runs?', queries[0])
            output = dict(line.split('=', 1) for line in Path(env['GITHUB_OUTPUT']).read_text().splitlines())
            self.assertEqual(json.loads(output['jobs']),
                             {'build': False, 'release': False, 'stub': True, 'hosted-build': False, 'hosted': True})

    # test-category: pure-logic
    def test_main_baseline_failure_selects_all_checks(self):
        for response in ([], [{'id': 1, 'status': 'completed', 'conclusion': 'success',
                              'event': 'push', 'head_branch': 'main',
                              'path': '.github/workflows/rust-quality.yml',
                              'head_repository': {'full_name': 'owner/repo'}, 'head_sha': 'b' * 40}]):
            for error in (OSError('API unavailable'), None):
                with tempfile.TemporaryDirectory() as directory:
                    env = dict(GITHUB_EVENT_NAME='push', GITHUB_REF='refs/heads/main',
                               GITHUB_REPOSITORY='owner/repo', GITHUB_RUN_ID='3',
                               GITHUB_OUTPUT=directory + '/output', GITHUB_STEP_SUMMARY=directory + '/summary')
                    def command(*args):
                        if args[0] == 'gh':
                            if error:
                                raise error
                            return json.dumps({'workflow_runs': response})
                        if args[1:3] == ('merge-base', '--is-ancestor'):
                            raise subprocess.CalledProcessError(1, args)
                        return 'head'
                    with patch.dict(os.environ, env), \
                         patch.object(changes, 'command', side_effect=command), \
                         patch.object(changes, 'changed') as diff, \
                         patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
                        changes.select({'before': 'previous'}, 'rust-quality.yml')
                    diff.assert_not_called()
                    output = dict(line.split('=', 1) for line in Path(env['GITHUB_OUTPUT']).read_text().splitlines())
                    self.assertTrue(all(output[group] == 'true' for group in changes.GROUPS if group != 'shell'))
                    self.assertTrue(json.loads(output['jobs'])['macos-archive'])
                    self.assertTrue(json.loads(output['jobs'])['linux-native'])



class Precision(unittest.TestCase):
    # test-category: pure-logic
    def test_package_only_inputs_do_not_build_test_archives(self):
        flags = ['rust', 'package', 'install', 'linux-package', 'ui', 'site', 'ds', 'workflows']
        for values in itertools.product(['false', 'true'], repeat=4):
            outputs = dict.fromkeys(flags, 'false') | dict(zip(flags[:4], values), tier='smoke')
            jobs = changes.rust_jobs(outputs, 'pull_request')
            for platform in ['linux', 'macos', 'linux-arm64']:
                self.assertEqual(jobs[f'{platform}-archive'],
                                 outputs['rust'] == 'true' and platform == 'linux')
            self.assertEqual(jobs['linux-native'], False)
            self.assertEqual(jobs['linux-package-x64'], False)
            self.assertEqual(jobs['install-x64'], False)

    # test-category: pure-logic
    def test_only_unshipped_harness_inputs_omit_packaging(self):
        root = 'packages/butler-agent/rust/'
        cases = {
            'crates/butler-e2e/tests/e2e/new.rs': False,
            'crates/butler-e2e/fixtures/new/input.json': False,
            'crates/butler-e2e/src/lib.rs': True,
            'crates/butler-e2e/Cargo.toml': True,
            'crates/butler-platform/src/lib.rs': True,
            'scripts/package-standalone-agent.py': True,
            'Cargo.lock': True,
        }
        for path, package in cases.items():
            groups = changes.categories(root + path)
            self.assertIn('rust', groups)
            for group in ['package', 'install', 'linux-package']:
                self.assertEqual(group in groups, package, (path, group))

    # test-category: pure-logic
    def test_ds_follows_viewer_build_and_smoke_inputs(self):
        for path, expected in {
            'packages/butler-app/client/ui/vite.ds-site.config.ts': True,
            'tests/smoke/ds-site-smoke.ts': True,
            'tests/smoke/font-assets-check.ts': True,
            'tests/support/smoke-browser.ts': True,
            'tests/support/ds-viewer-mobile-checks.ts': True,
            'package.json': True,
            'tools/validate.ts': True,
            'tests/unit/queue.test.ts': True,
            'packages/project-ledger/src/index.ts': True,
            'packages/butler-app/client/electron/src/main.ts': True,
        }.items():
            self.assertEqual('ds' in changes.categories(path), expected, path)

    # test-category: pure-logic
    def test_license_lock_patterns_do_not_match_source_names(self):
        for name, expected in {
            'Cargo.lock': True, 'bun.lockb': True, 'package-lock.json': True,
            'npm-shrinkwrap.json': False, 'block.rs': False, 'clock.ts': False,
            'instance_lock.rs': False,
        }.items():
            path = 'packages/butler-agent/rust/crates/butler-core/src/' + name
            self.assertEqual('licenses' in changes.categories(path), expected, path)
