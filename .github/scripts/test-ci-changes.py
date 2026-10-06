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
            'bun.lock': {'ui', 'site', 'ds', 'licenses'},
            'bun.lockb': {'ui', 'site', 'ds', 'licenses'},
            'packages/butler-agent/rust/crates/butler-core/src/lib.rs': {'rust', 'package', 'install', 'linux-package'},
            'packages/butler-agent/rust/Cargo.lock': {'rust', 'package', 'install', 'linux-package', 'licenses'},
            'Cargo.toml': {'rust', 'package', 'install', 'linux-package', 'licenses'},
            'new-crate/Cargo.toml': {'rust', 'package', 'install', 'linux-package', 'licenses'},
            'new-crate/Cargo.lock': {'rust', 'package', 'install', 'linux-package', 'licenses'},
            'packages/butler-app/client/electron/src/main.ts': {'ui', 'ds', 'package', 'install', 'linux-package'},
            'deploy/install.sh': {'package', 'install', 'linux-package'},
            'packages/butler-site/src/pages/index.astro': {'site'},
            'README.md': set(),
            'packages/butler-agent/rust/docs/install-layout.md': set(),
            'packages/butler-agent/resources/skills/status/SKILL.md': {'rust', 'package', 'install', 'linux-package'},
            'packages/butler-agent/rust/crates/butler-e2e/fixtures/memory/rule.md': {'rust', 'package', 'install', 'linux-package'},
            'packages/butler-app/scripts/release/package-versions.ts': {'ui', 'ds', 'package', 'install', 'linux-package'},
            'notes.md': set(),
            '.github/pull_request_template.md': set(changes.GROUPS),
            '.github/workflows/windows.yml': set(changes.GROUPS),
            'new-build-config.ini': set(changes.GROUPS) - {'workflows'},
        }
        workflow = (ROOT.parent / 'workflows/rust-quality.yml').read_text()
        lint = workflow.split('  lint:\n', 1)[1].split('  gate:\n', 1)[0]
        self.assertNotIn('    if:', lint)  # Docs-only PRs must run the tracked-document guard.
        self.assertIn('work-docs-lint.py', lint)
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(changes.categories(path), expected)

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
                rust = root / 'packages/butler-agent/rust/src/main.rs'
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
        with patch.object(changes, 'command', return_value='{"workflow_runs":[]}') as api:
            self.assertEqual(list(changes.previous('owner/repo', 12, 'rust-quality.yml', 'codex/a&b')), [])
        url = api.call_args.args[2]
        self.assertTrue(url.endswith('event=pull_request&per_page=100&branch=codex%2Fa%26b'), url)

    # test-category: pure-logic
    def test_non_pr_events_keep_existing_full_coverage(self):
        for event_name in ['push', 'merge_group', 'schedule', 'workflow_dispatch']:
            with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as temporary:
                env = dict(GITHUB_EVENT_NAME=event_name, GITHUB_REPOSITORY='owner/repo',
                           GITHUB_RUN_ID='2', GITHUB_OUTPUT=str(Path(temporary) / 'output'),
                           GITHUB_STEP_SUMMARY=str(Path(temporary) / 'summary'))
                with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='checkout'), \
                     patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
                    changes.select({'before': 'base'}, 'rust-quality.yml')
                output = (Path(temporary) / 'output').read_text()
                for group in changes.GROUPS:
                    self.assertIn(group + '=' + ('false' if group == 'package' else 'true'), output)

    # test-category: security
    def test_every_selected_gate_check_is_owned_by_a_receipt_group(self):
        workflow = (ROOT.parent / 'workflows/rust-quality.yml').read_text()
        groups = json.loads(re.search(r"groups: '([^']+)'", workflow).group(1))
        # Evaluate the actual gate's selection policy, without its result loop.
        policy = (ROOT / 'check-gate.py').read_text().split("if 'lint' in jobs:")[0]
        flags = ['rust', 'package', 'install', 'linux-package', 'ui', 'site', 'ds']
        for values in itertools.product(['false', 'true'], repeat=len(flags)):
            outputs = dict(zip(flags, values))
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


if __name__ == '__main__':
    unittest.main()
