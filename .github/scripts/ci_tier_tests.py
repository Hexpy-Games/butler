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


def selection(paths, event='pull_request', workflow='rust-quality.yml', labels=()):
    with tempfile.TemporaryDirectory() as directory:
        env = dict(GITHUB_EVENT_NAME=event, GITHUB_REF='refs/heads/main',
                   GITHUB_REPOSITORY='owner/repo', GITHUB_RUN_ID='2',
                   GITHUB_OUTPUT=directory + '/output', GITHUB_STEP_SUMMARY=directory + '/summary')
        payload = {'pull_request': {'number': 1, 'base': {'sha': 'base'},
                                   'labels': [{'name': label} for label in labels]}} if event == 'pull_request' else ({} if event == 'workflow_dispatch' else {'before': 'base'})
        with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='head'), \
             patch.object(changes, 'changed', return_value=paths), \
             patch.object(changes, 'previous', return_value=iter([])), \
             patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
            changes.select(payload, workflow)
        return dict(line.split('=', 1) for line in Path(env['GITHUB_OUTPUT']).read_text().splitlines())


class ApprovedTiers(unittest.TestCase):
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
                    self.assertEqual(jobs[name], event != 'pull_request' or path != rust, (event, path, name))
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
            ('pull_request', [rust], (), False),
            ('pull_request', [windows], (), True),
            ('pull_request', ['packages/butler-agent/rust/crates/butler-core/src/windows/native.rs'], (), True),
            ('pull_request', [rust], ('ci:windows-native',), True),
            ('push', [rust], (), True), ('push', ['README.md'], (), False),
            ('workflow_dispatch', [], (), True),
        ]:
            output = selection(paths, event, workflow, labels)
            jobs = json.loads(output['jobs'])
            self.assertEqual(jobs, dict(build=False, release=False, stub=native, hosted=native))
            results = {'changes': {'result': 'success', 'outputs': output}}
            results.update({name: {'result': 'success' if enabled else 'skipped'} for name, enabled in jobs.items()})
            env = dict(os.environ, RESULTS=json.dumps(results), CHECK_GROUPS=json.dumps(dict.fromkeys(jobs, 'jobs')))
            run = subprocess.run(['python3', str(ROOT / 'ci-check-selected.py')], env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        integration = dict(package='true', windows='true', tier='integration')
        self.assertTrue(all(changes.windows_preview_jobs(integration, 'push').values()))
        source = (ROOT.parent / 'workflows' / workflow).read_text()
        trigger = source.split('  pull_request:\n')[1].split('  push:')[0]
        self.assertEqual(set(re.findall(r"- '([^']+)'", trigger)), set(changes.WINDOWS))
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
                    self.assertEqual(jobs[name], on_pr if event == 'pull_request' else output['rust'] == 'true', (path, event))
                self.assertEqual(jobs['linux-tests'], output['rust'] == 'true')
        source = (ROOT.parent / 'workflows/rust-quality.yml').read_text()
        for name in ('macos-archive', 'macos-tests'):
            block = re.split(r'^  [\w-]+:', source.split('  ' + name + ':')[1], maxsplit=1, flags=re.M)[0]
            self.assertIn("fromJSON(needs.changes.outputs.jobs)['" + name + "']", block)


class Precision(unittest.TestCase):
    # test-category: pure-logic
    def test_package_only_inputs_do_not_build_test_archives(self):
        flags = ['rust', 'package', 'install', 'linux-package', 'ui', 'site', 'ds']
        for values in itertools.product(['false', 'true'], repeat=4):
            outputs = dict.fromkeys(flags, 'false') | dict(zip(flags[:4], values), tier='smoke')
            jobs = changes.rust_jobs(outputs, 'pull_request')
            for platform in ['linux', 'macos', 'linux-arm64']:
                self.assertEqual(jobs[f'{platform}-archive'],
                                 outputs['rust'] == 'true' and platform == 'linux')
            self.assertEqual(jobs['linux-native'], 'true' in values[2:])
            self.assertEqual(jobs['linux-package-x64'], outputs['linux-package'] == 'true')
            self.assertEqual(jobs['install-x64'], outputs['install'] == 'true')

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


