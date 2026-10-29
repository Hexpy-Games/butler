#!/usr/bin/env python3
"""Pure selection logic and security boundaries for CI result reuse."""
import contextlib
import importlib.util
import json
import itertools
import re
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('changes', ROOT / 'ci-changes.py')
changes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changes)


class Paths(unittest.TestCase):
    # test-category: pure-logic
    def test_responsible_jobs_and_workflow_fail_closed(self):
        cases = {
            'packages/butler-app/client/ui/src/app.tsx': {'ui', 'site', 'ds'},
            'packages/butler-i18n/src/locale.ts': {'ui', 'site', 'ds'},
            'packages/project-ledger/src/index.ts': {'ui', 'ds'},
            'bun.lock': {'ui', 'site', 'ds', 'licenses', 'signing'},
            'bun.lockb': {'ui', 'site', 'ds', 'licenses', 'signing'},
            'packages/butler-agent/rust/crates/butler-core/src/lib.rs': {'rust', 'package', 'install', 'linux-package'},
            'packages/butler-agent/rust/Cargo.lock': {'rust', 'package', 'install', 'linux-package', 'licenses'},
            'Cargo.toml': {'rust', 'package', 'install', 'linux-package', 'licenses'},
            'new-crate/Cargo.toml': {'rust', 'package', 'install', 'linux-package', 'licenses'},
            'new-crate/Cargo.lock': {'rust', 'package', 'install', 'linux-package', 'licenses'},
            'packages/butler-app/client/electron/src/main.ts': {'rust', 'ui', 'ds', 'package', 'install', 'linux-package', 'signing'},
            'deploy/install.sh': {'package', 'install', 'linux-package'},
            'packages/butler-site/src/pages/index.astro': {'site'},
            'README.md': set(),
            'packages/butler-agent/rust/docs/install-layout.md': set(),
            'packages/butler-agent/resources/skills/status/SKILL.md': {'rust', 'package', 'install', 'linux-package'},
            'packages/butler-agent/rust/crates/butler-e2e/fixtures/memory/rule.md': {'rust'},
            'packages/butler-app/scripts/release/package-versions.ts': {'rust', 'ui', 'ds', 'package', 'install', 'linux-package', 'signing'},
            'notes.md': set(),
            '.github/pull_request_template.md': set(),
            '.github/workflows/windows.yml': {'rust', 'ui', 'package'},
            'packages/butler-agent/rust/scripts/check_host_links.py': {'rust', 'package', 'install', 'linux-package', 'signing'},
            'new-build-config.ini': set(changes.GROUPS) - {'workflows', 'shell'},
        }
        workflow = (ROOT.parent / 'workflows/rust-quality.yml').read_text()
        lint = workflow.split('  lint:\n', 1)[1].split('  gate:\n', 1)[0]
        self.assertIn("fromJSON(needs.changes.outputs.jobs).lint", lint)  # PRs always run the tracked-document guard.
        self.assertIn('work-docs-lint.py', lint)
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(changes.categories(path), expected)

    # test-category: pure-logic
    def test_release_python_invalidates_native_consumers(self):
        path = '.github/actions/release-python/action.yml'
        self.assertTrue(changes.windows_native(path))
        self.assertTrue(set(changes.NATIVE_CI).issubset(changes.categories(path)))

    # test-category: pure-logic
    def test_github_inputs_follow_consumers_and_unknowns_fail_closed(self):
        from ci_consumer_test_support import consumer_groups
        for path, groups in consumer_groups(set(changes.GROUPS) - {'shell'}).items():
            with self.subTest(path=path):
                if path != '.github/workflows/shell.yml':  # Explicit shell inputs.
                    self.assertGreaterEqual(changes.categories(path), groups)
        for path in ['.github/workflows/new-check.yml',
                     '.github/actions/new-setup/action.yml',
                     '.github/scripts/new-helper.py', '.github/actionlint.yaml']:
            with self.subTest(path=path):
                self.assertEqual(changes.categories(path), set(changes.GROUPS) - {'shell'})
        for path in ['.github/releases/v1.2.3.md', '.github/actions/windows-runner-setup/README.md']:
            self.assertEqual(changes.categories(path), set())

    # test-category: pure-logic
    def test_consumer_derivation_follows_reuse_actions_and_python_imports(self):
        import ci_consumer_test_support as consumers
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {
                '.github/workflows/root.yml': """name: Root
jobs:
  producer:
    if: >-
      needs.changes.outputs.package == 'true'
    uses: ./.github/workflows/child.yml
  verifier:
    needs: producer
    if: needs.changes.outputs.install == 'true'
    steps:
      - run: python3 .github/scripts/verify.py
  gate:
    steps:
      - run: echo receipt
        groups: '{"package": ["producer"], "install": ["verifier"]}'
""",
                '.github/workflows/child.yml': """on:
  workflow_call:
jobs:
  build:
    steps:
      - uses: ./.github/actions/setup
""",
                '.github/actions/setup/action.yaml': """runs:
  using: composite
  steps:
    - run: python3 .github/scripts/direct.py
""",
                '.github/scripts/direct.py': 'import local\n',
                '.github/scripts/local.py': 'import importlib\nimportlib.import_module("dynamic")\n',
                '.github/scripts/dynamic.py': 'import direct\n',
                '.github/scripts/verify.py': 'from local import value\n',
            }
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            with patch.object(consumers, 'ROOT', root):
                derived = consumers.consumer_groups(set(changes.GROUPS) - {'shell'})
            native = {'package', 'rust', 'ui'}
            self.assertEqual(derived['.github/workflows/child.yml'], native)
            self.assertEqual(derived['.github/actions/setup/action.yaml'], native)
            self.assertEqual(derived['.github/scripts/direct.py'], native | {'install'})
            self.assertEqual(derived['.github/scripts/dynamic.py'], native | {'install'})
            self.assertEqual(derived['.github/scripts/verify.py'], native | {'install'})

    # test-category: pure-logic
    def test_windows_native_smoke_follows_windows_inputs_only(self):
        for path, expected in {
            'packages/butler-agent/rust/crates/butler-core/src/lib.rs': False,
            'packages/butler-agent/rust/Cargo.lock': False,
            'deploy/windows-preview-quality.ps1': True,
            '.github/workflows/windows-preview-smoke.yml': True,
            '.github/actions/build-windows-debug-agent/action.yml': True,
            '.github/actions/rust-agent-setup/action.yml': True,
            '.github/scripts/prepare-windows-zstd.py': True,
            '.github/workflows/e2e.yml': False,
            '.github/scripts/ci-changes.py': False,
            '.github/pull_request_template.md': False,
            'deploy/install.sh': False,
            'packages/butler-app/client/electron/src/main.ts': False,
            'packages/butler-agent/rust/docs/install-layout.md': False,
            'README.md': False,
        }.items():
            with self.subTest(path=path):
                self.assertEqual(changes.windows_native(path), expected)

    # test-category: security
    def test_every_locked_license_input_selects_its_validator(self):
        self.assertGreater(len(changes.LICENSE_INPUTS), 20)
        for path in changes.LICENSE_INPUTS:
            with self.subTest(path=path):
                self.assertIn('licenses', changes.categories(path))
        for path in ['packages/butler-app/client/ui/src/libs/design-system/fonts/LICENSE.md',
                     'packages/butler-agent/resources/new-model/NOTICE.txt']:
            self.assertIn('licenses', changes.categories(path))

    # test-category: pure-logic
    def test_content_modes_deletions_and_renames_are_hashed(self):
        original = Path.cwd()
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as temporary:
            root = Path(temporary)
            try:
                os.chdir(root)
                def git(*args):
                    return changes.command('git', *args)
                git('init', '-q')
                git('config', 'user.email', 'ci@example.invalid')
                git('config', 'user.name', 'CI test')
                rust = root / 'packages/butler-agent/rust/crates/butler-agent-cli/src/main.rs'
                rust.parent.mkdir(parents=True)
                rust.write_text('rust input')
                ui = root / 'packages/butler-app/client/ui/src/app.ts'
                ui.parent.mkdir(parents=True)
                ui.write_text('ui input')
                git('add', '.')
                git('commit', '-qm', 'base')
                base = git('rev-parse', 'HEAD')
                hashes = changes.hashes(base)
                ui.write_text('new complete ui input')
                git('add', '.')
                git('commit', '-qm', 'UI only')
                updated = changes.hashes(base)
                self.assertEqual(hashes['rust'], updated['rust'])
                self.assertEqual(hashes['package'], updated['package'])
                self.assertNotEqual(hashes['ui'], updated['ui'])
                self.assertEqual(changes.changed(base), [str(ui.relative_to(root))])
                rust.chmod(0o755)
                git('add', '.')
                git('commit', '-qm', 'mode')
                self.assertNotEqual(updated['rust'], changes.hashes(base)['rust'])
                before = git('rev-parse', 'HEAD')
                rust.rename(rust.with_name('renamed.rs'))
                git('add', '-A')
                git('commit', '-qm', 'rename')
                self.assertEqual(len(changes.changed(before)), 2)
                self.assertNotEqual(updated['rust'], changes.hashes(base)['rust'])
                ui.unlink()
                git('add', '-A')
                git('commit', '-qm', 'delete')
                self.assertNotEqual(updated['ui'], changes.hashes(base)['ui'])
            finally:
                os.chdir(original)


    def test_changed_ignores_base_branch_commits_after_the_fork(self):
        original = Path.cwd()
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as temporary:
            root = Path(temporary)
            try:
                os.chdir(root)
                def git(*args):
                    return changes.command('git', *args)
                git('init', '-q', '-b', 'main')
                git('config', 'user.email', 'ci@example.invalid')
                git('config', 'user.name', 'CI test')
                (root / 'README.md').write_text('start')
                git('add', '.')
                git('commit', '-qm', 'fork point')
                git('switch', '-qc', 'docs')
                (root / 'AGENTS.md').write_text('docs change')
                git('add', '.')
                git('commit', '-qm', 'docs only')
                git('switch', '-q', 'main')
                rust = root / 'packages/butler-agent/rust/src/lib.rs'
                rust.parent.mkdir(parents=True)
                rust.write_text('main moved on')
                git('add', '.')
                git('commit', '-qm', 'later main commit')
                main_tip = git('rev-parse', 'HEAD')
                git('switch', '-q', 'docs')
                self.assertEqual(changes.changed(main_tip), ['AGENTS.md'])
            finally:
                os.chdir(original)

class Trust(unittest.TestCase):
    # test-category: security
    def test_receipt_history_is_scoped_to_the_pr_branch(self):
        with patch.object(changes, 'command', return_value='[{"workflow_runs":[]}]') as api:
            self.assertEqual(list(changes.previous('owner/repo', 12, 'rust-quality.yml', 'ci/a&b')), [])
        url = api.call_args.args[2]
        self.assertTrue(url.endswith('event=pull_request&per_page=100&branch=ci%2Fa%26b'), url)

    # test-category: pure-logic
    def test_pr_main_release_tiers_and_zero_base(self):
        for event_name, ref, event, expected in [
            ('pull_request', 'refs/pull/12/merge', {'pull_request': {'number': 12, 'base': {'sha': 'base'}}}, 'smoke'),
            ('push', 'refs/heads/main', {'before': 'base'}, 'smoke'),
            ('push', 'refs/heads/release/0.1.0-preview.11', {'before': 'base'}, 'integration'),
            ('workflow_dispatch', 'refs/heads/release/0.1.0', {}, 'integration'),
            ('push', 'refs/heads/main', {'before': '0' * 40}, 'smoke'),
        ]:
            with tempfile.TemporaryDirectory() as temporary:
                env = dict(GITHUB_EVENT_NAME=event_name, GITHUB_REF=ref, GITHUB_REPOSITORY='owner/repo',
                           GITHUB_RUN_ID='2', GITHUB_OUTPUT=str(Path(temporary) / 'output'),
                           GITHUB_STEP_SUMMARY=str(Path(temporary) / 'summary'))
                with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='checkout'), \
                     patch.object(changes, 'changed', return_value=['packages/butler-app/client/ui/src/app.tsx']), \
                     patch.object(changes, 'previous', return_value=iter([])), \
                     patch.object(changes, 'main_base', return_value=None if event.get('before') == '0' * 40 else 'base'), \
                     patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
                    changes.select(event, 'rust-quality.yml')
                output = (Path(temporary) / 'output').read_text()
                self.assertIn('tier=' + expected, output)
                full = expected == 'integration' or event.get('before') == '0' * 40
                self.assertIn('rust=' + str(full).lower(), output)
                self.assertIn('ui=true', output)

    # test-category: pure-logic
    def test_windows_preview_installers_never_run_on_pull_requests(self):
        # PRs run hosted shards only for Windows agent crates or Windows inputs.
        rust, workflow = 'packages/butler-agent/rust/crates/butler-core/src/lib.rs', '.github/workflows/e2e.yml'
        pr = {'pull_request': {'number': 12, 'base': {'sha': 'base'}}}
        none = dict.fromkeys(['build', 'stub', 'hosted-build', 'release', 'hosted'], False)
        hosted, native = dict(none, **{'hosted-build': True, 'hosted': True}), dict(none, stub=True, hosted=True)
        for event_name, ref, event, paths, expected in [
            ('pull_request', 'refs/pull/12/merge', pr, ['docs/notes.md', workflow], none),
            ('pull_request', 'refs/pull/12/merge', pr, ['deploy/install.sh', 'packages/butler-npm/index.js'], none),
            ('pull_request', 'refs/pull/12/merge', pr, [rust], hosted),
            ('pull_request', 'refs/pull/12/merge', pr, ['packages/butler-agent/rust/crates/butler-e2e/tests/e2e/new.rs'], none),
            ('pull_request', 'refs/pull/12/merge', pr, ['.github/workflows/windows-preview-smoke.yml'], hosted),
            ('pull_request', 'refs/pull/12/merge', pr, ['.github/actions/build-windows-agent/action.yml'], hosted),
            ('pull_request', 'refs/pull/12/merge', pr, ['.github/workflows/windows-installer.yml'], hosted),
            ('pull_request', 'refs/pull/12/merge', pr, ['.github/scripts/ci-changes.py'], none),
            ('pull_request', 'refs/pull/12/merge', pr, ['.github/releases/v1.2.3.md'], none),
            ('pull_request', 'refs/pull/12/merge', pr, ['deploy/windows-preview-smoke.ps1'], hosted),
            ('workflow_dispatch', 'refs/heads/main', {}, [], native),
        ]:
            with self.subTest(event=event_name, paths=paths), tempfile.TemporaryDirectory() as temporary:
                env = dict(GITHUB_EVENT_NAME=event_name, GITHUB_REF=ref, GITHUB_REPOSITORY='owner/repo',
                           GITHUB_RUN_ID='2', GITHUB_OUTPUT=str(Path(temporary) / 'output'),
                           GITHUB_STEP_SUMMARY=str(Path(temporary) / 'summary'))
                with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='checkout'), \
                     patch.object(changes, 'changed', return_value=paths), \
                     patch.object(changes, 'previous', return_value=iter([])), \
                     patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
                    changes.select(event, 'windows-preview-smoke.yml')
                output = dict(line.split('=', 1) for line in (Path(temporary) / 'output').read_text().splitlines())
                self.assertEqual(json.loads(output['jobs']), expected)

    # test-category: security
    def test_invalid_candidate_fails_closed(self):
        for ref in ['refs/heads/release/latest', 'refs/heads/release/0.1.0-beta.1', 'refs/heads/release/0.1.0-preview.11/extra']:
            with patch.dict(os.environ, GITHUB_EVENT_NAME='push', GITHUB_REF=ref):
                with self.assertRaises(ValueError):
                    changes.tier()

    # test-category: security
    def test_every_selected_gate_check_is_owned_by_a_receipt_group(self):
        workflow = (ROOT.parent / 'workflows/rust-quality.yml').read_text()
        groups = json.loads(re.search(r"groups: '([^']+)'", workflow).group(1))
        # Evaluate the actual gate's selection policy, without its result loop.
        policy = (ROOT / 'check-gate.py').read_text().split("for name, enabled in selected.items():")[0]
        flags = ['rust', 'package', 'install', 'linux-package', 'ui', 'site', 'ds', 'licenses', 'signing']
        for values in itertools.product(['false', 'true'], repeat=len(flags)):
            outputs = dict(zip(flags, values), tier='smoke', workflows='true')
            outputs['jobs'] = json.dumps(changes.rust_jobs(outputs, 'pull_request') | {'lint': True})
            jobs = {'changes': {'result': 'success', 'outputs': outputs}}
            with patch.dict(os.environ, RESULTS=json.dumps(jobs), EVENT='pull_request'):
                scope = {}
                exec(compile(policy, 'gate-policy', 'exec'), scope)
            covered = {name for group, names in groups.items() if outputs[group] == 'true'
                       for name in names}
            selected = {name for name, enabled in scope['selected'].items() if enabled}
            self.assertFalse(selected - covered, (outputs, selected - covered))

    # test-category: security
    def test_receipts_only_from_same_pr_repo_workflow_and_completed_runs(self):
        run = dict(status='completed', conclusion='success', event='pull_request',
                   path='.github/workflows/rust-quality.yml', head_repository={'full_name': 'owner/repo'},
                   pull_requests=[{'number': 12}])
        self.assertTrue(changes.trusted_run(run, 'owner/repo', 12, 'rust-quality.yml'))
        for key, value in [('status', 'in_progress'), ('conclusion', 'cancelled'), ('event', 'push'),
                           ('path', '.github/workflows/other.yml'),
                           ('head_repository', {'full_name': 'fork/repo'}), ('pull_requests', [{'number': 13}])]:
            with self.subTest(key=key):
                self.assertFalse(changes.trusted_run(dict(run, **{key: value}), 'owner/repo', 12, 'rust-quality.yml'))

    # test-category: security
    def test_failed_cancelled_partial_and_unselected_groups_are_never_recorded(self):
        for results in [('success', 'success'), ('failure', 'success'), ('cancelled', 'success'),
                        ('skipped', 'success'), ('success', 'skipped')]:
            with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as temporary:
                state = dict(schema=1, hashes={'rust': 'complete'}, outputs={'rust': 'true'}, reuse={})
                jobs = dict(changes=dict(result='success', outputs={'selection': json.dumps(state)}),
                            build={'result': results[0]}, tests={'result': results[1]})
                with patch.dict(os.environ, RUNNER_TEMP=temporary, RESULTS=json.dumps(jobs),
                                JOB_GROUPS='{"rust":["build","tests"]}'):
                    changes.record()
                receipt = json.loads((Path(temporary) / 'ci-inputs/inputs.json').read_text())
                self.assertEqual(receipt['hashes'], {'rust': 'complete'} if results == ('success', 'success') else {})

    # test-category: security
    def test_gate_rejects_failures_cancellations_and_unexpected_skips(self):
        for enabled in ['true', 'false']:
            for result in ['success', 'failure', 'cancelled', 'skipped']:
                jobs = dict(changes=dict(result='success', outputs={'ui': enabled}), ui=dict(result=result))
                env = dict(os.environ, RESULTS=json.dumps(jobs), CHECK_GROUPS='{"ui":["ui"]}')
                actual = subprocess.run(['python3', ROOT / 'ci-check-selected.py'], env=env, capture_output=True)
                self.assertEqual(actual.returncode == 0, result == ('success' if enabled == 'true' else 'skipped'))

    # test-category: security
    def test_gate_can_follow_the_selected_job_policy(self):
        for selected in [True, False]:
            for result in ['success', 'failure', 'cancelled', 'skipped']:
                outputs = {'tier': 'smoke', 'package': 'true', 'jobs': json.dumps({'build': selected})}
                jobs = dict(changes=dict(result='success', outputs=outputs), build=dict(result=result))
                env = dict(os.environ, RESULTS=json.dumps(jobs), CHECK_GROUPS='{"build":"jobs"}')
                actual = subprocess.run(['python3', ROOT / 'ci-check-selected.py'], env=env, capture_output=True)
                self.assertEqual(actual.returncode == 0, result == ('success' if selected else 'skipped'))

    # test-category: pure-logic
    def test_reused_x64_install_restores_shared_npm_tarball(self):
        workflow = 'rust-quality.yml'
        inputs = changes.integration_inputs(workflow, dict.fromkeys(changes.GROUPS, 'hash'),
                                            '0.1.0-preview.11')
        receipt = dict(run=7, job_inputs=inputs, job_hashes={'install-x64': inputs['install-x64']})
        _, reused = changes.reuse_inputs('owner/repo', None, workflow, 'release/0.1.0-preview.11',
                                         {}, inputs, receipts=[receipt])
        artifacts = [dict(name=artifact, run=run) for name, run in reused.items()
                     for artifact in changes.producer_artifacts(workflow, name)]
        self.assertEqual(reused, {'install-x64': 7})
        self.assertEqual(artifacts, [dict(name='agent-linux-x64', run=7),
                                     dict(name='butler-npm-x64', run=7)])



class WorkflowScheduling(unittest.TestCase):
    # test-category: pure-logic
    def test_installer_verify_condition_truth_table(self):
        source = (ROOT.parent / 'workflows/windows-installer.yml').read_text()
        verify = source.split('\n  verify:\n', 1)[1].split('\n  gate:', 1)[0]
        expression = re.search(r'^    if: \$\{\{ (.*) \}\}$', verify, re.M)[1]
        results = ('success', 'failure', 'cancelled', 'skipped')
        cases = itertools.product(results, ('smoke', 'integration'), (False, True),
                                  ('', '123'), (False, True), results)
        for build, tier, cancelled, reuse, selected, changes_result in cases:
            with self.subTest(build=build, tier=tier, cancelled=cancelled,
                              reuse=reuse, selected=selected, changes=changes_result):
                condition = expression
                values = {'cancelled()': cancelled, 'always()': True,
                          'needs.changes.result': changes_result,
                          'needs.build.result': build, 'inputs.reuse-run': reuse,
                          'needs.changes.outputs.tier': tier,
                          'fromJSON(needs.changes.outputs.jobs).verify': selected}
                for name, value in values.items():
                    condition = condition.replace(name, repr(value))
                condition = re.sub(r'!(?!=)', 'not ', condition)
                condition = condition.replace('&&', 'and').replace('||', 'or')
                if cancelled or changes_result != 'success':
                    expected = False
                elif tier == 'integration':
                    expected = selected and build in ('success', 'skipped')
                else:
                    expected = build == 'success' or bool(reuse)
                self.assertEqual(bool(eval(condition, {'__builtins__': {}})), expected)

    # test-category: format-pin
    def test_release_keeps_job_locks_without_workflow_pending_cancellation(self):
        source = (ROOT.parent / 'workflows/release.yml').read_text()
        self.assertNotRegex(source, r'(?m)^concurrency:')
        groups = {'agent-windows-build': 'windows-release-${{ github.ref }}',
                  'app-windows': 'windows-app-release-${{ github.ref }}',
                  'recover-release': 'release-publication-recovery'}
        for job, group in groups.items():
            block = source.split(f'\n  {job}:\n', 1)[1]
            block = re.split(r'\n  [a-z][a-z0-9-]*:\n', block, maxsplit=1)[0]
            self.assertIn(f'    concurrency:\n      group: {group}\n'
                          '      cancel-in-progress: false', block)

class TrimContracts(unittest.TestCase):
    # test-category: security
    def test_gate_uses_exported_job_selection_even_without_path_flags(self):
        for tier, name in itertools.product(['smoke', 'integration'],
                                            ['linux-clippy', 'windows-check', 'shellcheck', 'selftest']):
            for enabled in [True, False]:
                for result in ['success', 'failure', 'cancelled', 'skipped']:
                    outputs = {'tier': tier, 'jobs': json.dumps({name: enabled})}
                    jobs = {'changes': {'result': 'success', 'outputs': outputs},
                            name: {'result': result}}
                    env = dict(os.environ, RESULTS=json.dumps(jobs))
                    actual = subprocess.run(['python3', ROOT / 'check-gate.py'], env=env, capture_output=True)
                    self.assertEqual(actual.returncode == 0,
                                     result == ('success' if enabled else 'skipped'),
                                     (tier, enabled, result, actual.stderr))

    # test-category: security
    def test_license_failure_in_lint_keeps_gate_and_receipt_semantics(self):
        source = (ROOT.parent / 'workflows/rust-quality.yml').read_text()
        lint = source.split('  lint:\n', 1)[1].split('  gate:\n', 1)[0]
        for command in ['node deploy/licenses/generate.mjs --check',
                        'node deploy/licenses/check.mjs', 'python3 deploy/licenses/check-disclosure.py']:
            self.assertIn(command, lint)
        groups = json.loads(re.search(r"groups: '([^']+)'", source)[1])
        self.assertEqual(groups['licenses'], ['lint'])
        for tier, enabled, outcome in itertools.product(
                ['smoke', 'integration'], [True, False], ['success', 'failure', 'cancelled', 'skipped']):
            with self.subTest(tier=tier, enabled=enabled, outcome=outcome), tempfile.TemporaryDirectory() as temp:
                outputs = {'tier': tier, 'licenses': str(enabled or tier == 'integration').lower(),
                           'jobs': json.dumps({'lint': enabled})}
                state = dict(schema=1, workflow='rust-quality.yml', hashes={'licenses': 'complete'},
                             outputs=dict(outputs), reuse={},
                             job_inputs={'lint': 'job-hash'} if tier == 'integration' else {},
                             job_reuse={'lint': 1} if tier == 'integration' and not enabled else {})
                outputs['selection'] = json.dumps(state)
                jobs = {'changes': {'result': 'success', 'outputs': outputs}, 'lint': {'result': outcome}}
                env = dict(os.environ, RESULTS=json.dumps(jobs))
                actual = subprocess.run(['python3', ROOT / 'check-gate.py'], env=env, capture_output=True)
                passed = outcome == ('success' if enabled else 'skipped')
                self.assertEqual(actual.returncode == 0, passed, actual.stderr)
                with patch.dict(os.environ, env | {'RUNNER_TEMP': temp, 'JOB_GROUPS': '{"licenses":["lint"]}'}), \
                     patch.object(changes.ci_parts, 'inventory', return_value={}):
                    changes.record()
                receipt = json.loads((Path(temp) / 'ci-inputs/inputs.json').read_text())
                self.assertEqual(receipt['hashes'], {'licenses': 'complete'}
                                 if passed and outputs['licenses'] == 'true' else {})
                self.assertEqual(receipt['job_hashes'], {'lint': 'job-hash'}
                                 if passed and tier == 'integration' else {})

    # test-category: format-pin
    def test_empty_artifact_matrix_is_deselected_before_expansion(self):
        source = (ROOT.parent / 'workflows/ci-changes.yml').read_text().split('  artifacts:\n    needs: paths')[1]
        self.assertIn("if: needs.paths.outputs.artifacts != '[]'", source)
        self.assertIn('artifact: ${{ fromJSON(needs.paths.outputs.artifacts) }}', source)
        self.assertNotIn('"run":0', source)

# Keep the derived dependency checks in the existing CI-script test entrypoint.
from ci_windows_cascade_tests import WindowsCascade
from ci_input_tests import DerivedInputs
from ci_tier_tests import Precision, ApprovedTiers
from ci_ds_approval_tests import DSApproval, DSApprovalWiring
from ci_shell_tests import ShellSelection
from ci_runtime_tests import WindowsRuntimeSelection, SkippedIsNotPass


if __name__ == '__main__':
    unittest.main()
