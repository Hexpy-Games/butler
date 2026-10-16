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
            '.github/workflows/windows.yml': {'package'},
            'new-build-config.ini': set(changes.GROUPS) - {'workflows'},
        }
        workflow = (ROOT.parent / 'workflows/rust-quality.yml').read_text()
        lint = workflow.split('  lint:\n', 1)[1].split('  gate:\n', 1)[0]
        self.assertIn("    if: needs.changes.outputs.tier != 'integration'", lint)  # PRs always run the tracked-document guard.
        self.assertIn('work-docs-lint.py', lint)
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(changes.categories(path), expected)

    # test-category: pure-logic
    def test_github_inputs_follow_consumers_and_unknowns_fail_closed(self):
        cases = {
            '.github/releases/v1.2.3.md': set(),
            '.github/actions/windows-owner-setup/README.md': set(),
            '.github/workflows/release-macos.yml': {'workflows'},
            '.github/workflows/e2e.yml': {'workflows'},
            '.github/workflows/windows-installer.yml': {'workflows'},
            '.github/workflows/post-merge-ci.yml': {'workflows'},
            '.github/scripts/integration-proof.py': {'workflows'},
            '.github/scripts/ci-changes.py': {'workflows'},
            '.github/scripts/ds-approval.py': {'workflows'},
            '.github/scripts/test-ci-changes.py': {'workflows'},
            '.github/workflows/rust-tests.yml': {'rust'},
            '.github/workflows/rust-perf-archive.yml': {'rust'},
            '.github/actions/e2e-stub/action.yml': {'rust'},
            '.github/workflows/native-agent.yml': {'rust', 'package', 'install', 'linux-package'},
            '.github/actions/rust-agent-setup/action.yml': {'rust', 'package', 'install', 'linux-package'},
            '.github/actions/publish-cargo-target/action.yml': {'rust', 'package', 'install', 'linux-package'},
            '.github/workflows/macos-signing.yml': {'signing'},
            '.github/workflows/linux-packages.yml': {'linux-package'},
            '.github/workflows/install-smoke.yml': {'install'},
            '.github/workflows/bun-unit.yml': {'ui'},
            '.github/actions/bun-setup/action.yml': {'ui', 'site', 'ds', 'package', 'install', 'linux-package'},
            '.github/workflows/ds-site.yml': {'site', 'ds'},
            '.github/workflows/site-check.yml': {'site', 'ds'},
            '.github/actions/build-windows-agent/action.yml': {'package'},
            '.github/workflows/licenses.yml': {'licenses'},
            '.github/workflows/rust-quality.yml': set(changes.GROUPS),
            '.github/workflows/new-check.yml': set(changes.GROUPS),
            '.github/actions/new-setup/action.yml': set(changes.GROUPS),
            '.github/scripts/new-helper.py': set(changes.GROUPS),
            '.github/actionlint.yaml': set(changes.GROUPS),
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(changes.categories(path), expected)

    # test-category: pure-logic
    def test_windows_native_smoke_follows_rust_and_windows_inputs_only(self):
        for path, expected in {
            'packages/butler-agent/rust/crates/butler-core/src/lib.rs': True,
            'packages/butler-agent/rust/Cargo.lock': True,
            'deploy/windows-preview-quality.ps1': True,
            '.github/workflows/windows-preview-smoke.yml': True,
            '.github/actions/build-windows-debug-agent/action.yml': True,
            '.github/actions/rust-agent-setup/action.yml': True,
            '.github/scripts/prepare-windows-zstd.py': True,
            '.github/workflows/e2e.yml': False,
            '.github/scripts/ci-changes.py': False,
            '.github/pull_request_template.md': False,
            'deploy/install.sh': False,
            'packages/butler-app/client/electron/src/main.ts': True,
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
                     patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
                    changes.select(event, 'rust-quality.yml')
                output = (Path(temporary) / 'output').read_text()
                self.assertIn('tier=' + expected, output)
                full = expected == 'integration' or event.get('before') == '0' * 40
                self.assertIn('rust=' + str(full).lower(), output)
                self.assertIn('ui=true', output)

    # test-category: pure-logic
    def test_windows_preview_installers_never_run_on_pull_requests(self):
        rust, workflow = 'packages/butler-agent/rust/crates/butler-core/src/lib.rs', '.github/workflows/e2e.yml'
        pr = {'pull_request': {'number': 12, 'base': {'sha': 'base'}}}
        none = dict.fromkeys(['build', 'stub', 'release', 'hosted'], False)
        native = dict(none, stub=True, hosted=True)
        for event_name, ref, event, paths, expected in [
            ('pull_request', 'refs/pull/12/merge', pr, ['docs/notes.md', workflow], none),
            ('pull_request', 'refs/pull/12/merge', pr, ['deploy/install.sh', 'packages/butler-npm/index.js'], none),
            ('pull_request', 'refs/pull/12/merge', pr, [rust], native),
            ('pull_request', 'refs/pull/12/merge', pr, ['packages/butler-agent/rust/crates/butler-e2e/tests/e2e/new.rs'], native),
            ('pull_request', 'refs/pull/12/merge', pr, ['.github/workflows/windows-preview-smoke.yml'], native),
            ('pull_request', 'refs/pull/12/merge', pr, ['.github/actions/build-windows-agent/action.yml'], native),
            ('pull_request', 'refs/pull/12/merge', pr, ['.github/workflows/windows-installer.yml'], none),
            ('pull_request', 'refs/pull/12/merge', pr, ['.github/scripts/ci-changes.py'], none),
            ('pull_request', 'refs/pull/12/merge', pr, ['.github/releases/v1.2.3.md'], none),
            ('pull_request', 'refs/pull/12/merge', pr, ['deploy/windows-preview-smoke.ps1'], native),
            ('workflow_dispatch', 'refs/heads/main', {}, [], dict.fromkeys(none, True)),
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
        policy = (ROOT / 'check-gate.py').read_text().split("if 'lint' in jobs")[0]
        flags = ['rust', 'package', 'install', 'linux-package', 'ui', 'site', 'ds']
        for values in itertools.product(['false', 'true'], repeat=len(flags)):
            outputs = dict(zip(flags, values), tier='smoke', workflows='false')
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

    # test-category: security
    def test_hash_match_required_even_with_prior_success(self):
        state = dict(schema=1, repository='owner/repo', workflow='rust-quality.yml', pr=12,
                     run=1, hashes={'rust': 'rust-before', 'ui': 'ui-before'})
        event = {'pull_request': {'number': 12, 'base': {'sha': 'base'}}}
        for current, expected in [({'rust': 'rust-before', 'ui': 'ui-after'}, ('false', 'true')),
                                  ({'rust': 'rust-after', 'ui': 'ui-before'}, ('true', 'false')),
                                  ({'rust': 'rust-after', 'ui': 'ui-after'}, ('true', 'true'))]:
            with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as temporary:
                env = dict(GITHUB_EVENT_NAME='pull_request', GITHUB_REPOSITORY='owner/repo',
                           GITHUB_RUN_ID='2', GITHUB_OUTPUT=str(Path(temporary) / 'output'),
                           GITHUB_STEP_SUMMARY=str(Path(temporary) / 'summary'))
                with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='checkout'), \
                     patch.object(changes, 'changed', return_value=['.github/workflows/rust-quality.yml']), \
                     patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'other') | current), \
                     patch.object(changes, 'previous', return_value=iter([state])):
                    changes.select(event, 'rust-quality.yml')
                output = (Path(temporary) / 'output').read_text()
                self.assertIn('rust=' + expected[0], output)
                self.assertIn('ui=' + expected[1], output)


class Precision(unittest.TestCase):
    # test-category: pure-logic
    def test_package_only_inputs_do_not_build_test_archives(self):
        flags = ['rust', 'package', 'install', 'linux-package', 'ui', 'site', 'ds']
        for values in itertools.product(['false', 'true'], repeat=4):
            outputs = dict.fromkeys(flags, 'false') | dict(zip(flags[:4], values), tier='smoke')
            jobs = changes.rust_jobs(outputs, 'pull_request')
            for platform in ['linux', 'macos', 'linux-arm64']:
                self.assertEqual(jobs[f'{platform}-archive'], outputs['rust'] == 'true')
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

    # test-category: pure-logic
    def test_signing_selects_own_inputs_through_workflow_jobs(self):
        for path, expected in {
            'deploy/macos/sign-and-notarize.sh': True,
            'packages/butler-app/scripts/release/package-app-release.ts': True,
            'packages/butler-app/client/electron/entitlements.mac.plist': True,
            'packages/butler-agent/rust/scripts/package-standalone-agent.py': True,
            '.github/workflows/macos-signing.yml': True,
            'VERSION': True, 'bun.lock': True,
            'packages/butler-agent/rust/crates/butler-core/src/lib.rs': False,
            'deploy/linux-app-smoke.sh': False, 'deploy/install.sh': False,
        }.items():
            with self.subTest(path=path), tempfile.TemporaryDirectory() as temporary:
                env = dict(GITHUB_EVENT_NAME='pull_request', GITHUB_REF='refs/pull/1/merge',
                           GITHUB_REPOSITORY='owner/repo', GITHUB_RUN_ID='2',
                           GITHUB_OUTPUT=str(Path(temporary) / 'output'),
                           GITHUB_STEP_SUMMARY=str(Path(temporary) / 'summary'))
                with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='head'), \
                     patch.object(changes, 'changed', return_value=[path]), \
                     patch.object(changes, 'previous', return_value=iter([])), \
                     patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
                    changes.select({'pull_request': {'number': 1, 'base': {'sha': 'base'}}}, 'macos-signing.yml')
                output = dict(line.split('=', 1) for line in Path(env['GITHUB_OUTPUT']).read_text().splitlines())
                self.assertEqual(json.loads(output['jobs']), dict(shellcheck=expected, selftest=expected))
        self.assertEqual(changes.job_groups('macos-signing.yml'),
                         dict(shellcheck=['signing'], selftest=['signing']))


# Keep the derived dependency checks in the existing CI-script test entrypoint.
from ci_input_tests import DerivedInputs


if __name__ == '__main__':
    unittest.main()
