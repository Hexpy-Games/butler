"""DS approval enforcement and required-gate wiring, loaded by CI selection tests."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('ds_approval', ROOT / 'ds-approval.py')
ds = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ds)


def workflow(name):
    return (ROOT.parent / 'workflows' / name).read_text()


def job(source, name):
    return re.search(r'^  ' + re.escape(name) + r':\n(.*?)(?=^  [\w-]+:|\Z)',
                     source, re.M | re.S)[1]


class DSApproval(unittest.TestCase):
    def invoke(self, files, messages=(), labels=()):
        output = io.StringIO()
        with patch.object(ds, 'from_pr', return_value=(files, messages, labels)), \
             contextlib.redirect_stdout(output):
            result = ds.main(['--pr', '1'])
        return result, output.getvalue()

    # test-category: security
    def test_protected_changes_fail_with_one_error_per_file(self):
        paths = [ds.DS + name for name in ['components/button.tsx', 'blocks/nested/card.ts',
                                           'shadcn/nested/token.css', 'tokens.css']]
        result, output = self.invoke(paths + ['packages/butler-app/client/ui/src/app.tsx'])
        self.assertEqual(result, 1)
        errors = [line for line in output.splitlines() if line.startswith('::error file=')]
        self.assertEqual(len(errors), len(paths))
        for path in paths:
            self.assertEqual(sum(line.startswith(f'::error file={path},title=DS change without approval::')
                                 for line in errors), 1)
        self.assertIn('4 DS file(s) changed without approval', output)

    # test-category: security
    def test_review_material_and_non_ds_files_need_no_approval(self):
        paths = [ds.DS + 'components/button.' + suffix for suffix in
                 ['showcase.tsx', 'guidance.tsx', 'test.ts', 'fixtures.tsx']]
        paths.append('packages/butler-app/client/ui/src/app.tsx')
        self.assertEqual(self.invoke(paths), (0, 'No DS primitive, block or token changes.\n'))

    # test-category: security
    def test_trailer_on_any_commit_or_label_approves_changes(self):
        for messages, labels in [(['First commit', 'Change\n\nDS-Approved: x', 'Last commit'], []),
                                 (['Change'], ['ds-approved'])]:
            with self.subTest(messages=messages, labels=labels):
                self.assertEqual(self.invoke([ds.DS + 'tokens.css'], messages, labels),
                                 (0, 'DS change approved (1 file(s)).\n'))

    # test-category: security
    def test_entrypoint_fails_closed_on_api_bad_args_and_empty_repository(self):
        cases = [(['--pr', '1'], 'owner/repo', RuntimeError('API 50%\r\nunavailable'),
                  'API 50%25%0D%0Aunavailable'),
                 ([], 'owner/repo', None, 'Expected --pr <number> or --range BASE..HEAD'),
                 (['--pr', '1'], '', None, 'GITHUB_REPOSITORY is empty')]
        for args, repository, error, reason in cases:
            with self.subTest(args=args, repository=repository):
                output = io.StringIO()
                with patch.dict(os.environ, GITHUB_REPOSITORY=repository), \
                     patch.object(sys, 'argv', ['ds-approval.py'] + args), \
                     patch('subprocess.run', side_effect=error) as api, \
                     contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as exit:
                    runpy.run_path(str(ROOT / 'ds-approval.py'), run_name='__main__')
                self.assertEqual(exit.exception.code, 1)
                self.assertEqual(output.getvalue(), f'::error title=ds-approval::{reason}\n')
                if error:
                    api.assert_called_once()
                else:
                    api.assert_not_called()

    # test-category: security
    def test_range_mode_uses_the_same_exit_codes(self):
        for files, message, expected in [(ds.DS + 'tokens.css', 'Change', 1),
                                         (ds.DS + 'tokens.css', 'DS-Approved: x', 0),
                                         ('README.md', 'Change', 0)]:
            with self.subTest(files=files, message=message), \
                 patch.object(ds, 'run', side_effect=[files, message]), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ds.main(['--range', 'base..head']), expected)


class DSApprovalWiring(unittest.TestCase):
    # test-category: format-pin
    def test_approval_is_reusable_and_runs_independently_on_every_pr_event(self):
        source = workflow('ds-approval.yml')
        trigger = source.split('\non:\n', 1)[1].split('\npermissions:', 1)[0]
        self.assertEqual(trigger.strip(), 'workflow_call:')
        self.assertNotRegex(source, r'(?m)^\s*paths:')
        caller = job(workflow('rust-quality.yml'), 'ds-approval')
        self.assertIn("    if: github.event_name == 'pull_request'\n", caller)
        self.assertIn('    uses: ./.github/workflows/ds-approval.yml\n', caller)
        self.assertNotRegex(caller, r'(?m)^\s*needs:')

    # test-category: format-pin
    def test_gate_requires_approval_on_full_and_metadata_runs(self):
        gate = job(workflow('rust-quality.yml'), 'gate')
        needs = re.search(r'^    needs: \[([^\]]+)\]', gate, re.M)[1].split(', ')
        self.assertIn('ds-approval', needs)
        step = gate.split('      - name: Require DS approval\n', 1)[1]
        self.assertIn("        if: always() && github.event_name == 'pull_request'\n", step)
        self.assertIn('          RESULT: ${{ needs.ds-approval.result }}\n', step)
        self.assertNotIn('      - name:', step)

    # test-category: format-pin
    def test_selftest_reuses_the_macos_workflow(self):
        caller = job(workflow('rust-quality.yml'), 'selftest')
        self.assertIn('    needs: changes\n', caller)
        self.assertIn("    if: always() && !cancelled() && needs.changes.result == 'success' && fromJSON(needs.changes.outputs.jobs)['selftest']\n", caller)
        self.assertIn('    uses: ./.github/workflows/macos-selftest.yml\n', caller)
        source = workflow('macos-selftest.yml')
        self.assertIn('  workflow_call:\n', source)
        self.assertIn('runs-on: macos-15', source)
        self.assertIn('deploy/macos/selftest.sh', source)

    # test-category: security
    def test_gate_command_passes_only_success(self):
        step = job(workflow('rust-quality.yml'), 'gate').split('      - name: Require DS approval\n', 1)[1]
        command = re.search(r'^        run: (.+)$', step, re.M)[1]
        for result in ['failure', 'cancelled', 'skipped', 'success']:
            with self.subTest(result=result):
                completed = subprocess.run(['bash', '-c', command], env=dict(os.environ, RESULT=result))
                self.assertEqual(completed.returncode, 0 if result == 'success' else 1)
