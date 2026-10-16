#!/usr/bin/env python3
"""Offline fixtures for main-red blocking and metadata-only gate safety."""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('main_gate', Path(__file__).with_name('ci-main-gate.py'))
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)
REPO = 'owner/repo'
PR = dict(number=7, head=dict(ref='feat/change', sha='a' * 40, repo=dict(full_name=REPO)),
          base=dict(ref='main', repo=dict(full_name=REPO)), labels=[], body='')
RUN = dict(id=9, workflow_id=4, status='completed', conclusion='failure', head_sha='b' * 40,
           event='push', head_branch='main', path='.github/workflows/rust-quality.yml',
           head_repository=dict(full_name=REPO), html_url='https://github.com/owner/repo/actions/runs/9')
ISSUE = dict(state='open', user=dict(login='github-actions[bot]'), body=f'<!-- main-ci-range:green:{RUN["head_sha"]} -->\n'
                  '<!-- workflow:4 -->evidence<!-- /workflow:4 -->')


class MainGate(unittest.TestCase):
    def evaluate(self, runs, pr=None, error=None):
        output = io.StringIO()
        with patch.dict(os.environ, GITHUB_REPOSITORY=REPO), \
             patch.object(gate, 'main_workflows', return_value=['rust-quality.yml']), \
             patch.object(gate, 'command', return_value=json.dumps(dict(workflow_runs=runs)), side_effect=error) as command, \
             contextlib.redirect_stdout(output):
            result = gate.main_gate(dict(pull_request=pr or PR), REPO, 'pull_request')
        return result, output.getvalue(), command

    # test-category: pure-logic
    def test_passing_and_failing_main(self):
        self.assertEqual(self.evaluate([dict(RUN, conclusion='success')])[0], 0)
        result, output, command = self.evaluate([RUN])
        self.assertEqual(result, 1)
        self.assertEqual(len(output.splitlines()), 1)
        for text in [RUN['html_url'], 'fix/revert-pr-*', 'ci:main-fix', 'open main-failure issue']:
            self.assertIn(text, output)
        command.assert_called_once()
        self.assertIn('per_page=100', command.call_args.args[2])
        self.assertNotIn('--paginate', command.call_args.args)

    # test-category: pure-logic
    def test_cancelled_latest_falls_back_and_new_success_clears_failure(self):
        self.assertEqual(self.evaluate([dict(RUN, id=10, conclusion='cancelled'), RUN])[0], 1)
        self.assertEqual(self.evaluate([dict(RUN, id=10, conclusion='success'), RUN])[0], 0)

    # test-category: pure-logic
    def test_other_completed_conclusions_do_not_restore_older_failure(self):
        for conclusion in ('timed_out', 'neutral', 'skipped', 'action_required'):
            self.assertEqual(self.evaluate([dict(RUN, id=10, conclusion=conclusion), RUN])[0], 0)

    # test-category: security
    def test_branch_and_label_bypass_without_api(self):
        for pr in [dict(PR, head=dict(PR['head'], ref='fix/revert-pr-7-abc')),
                   dict(PR, labels=[dict(name='ci:main-fix')])]:
            result, _, command = self.evaluate([RUN], pr)
            self.assertEqual(result, 0)
            command.assert_not_called()

    # test-category: security
    def test_reporter_issue_bypass_checks_open_marker_and_author(self):
        pr = dict(PR, body='Fixes https://github.com/owner/repo/issues/1037')
        for issue, expected in [(ISSUE, 0), (dict(ISSUE, state='closed'), 1),
                                (dict(ISSUE, body='Main CI failure'), 1),
                                (dict(ISSUE, body=ISSUE['body'].replace(RUN['head_sha'], 'stale')), 1),
                                (dict(ISSUE, body=ISSUE['body'].replace('workflow:4', 'workflow:5')), 1),
                                (dict(ISSUE, user=dict(login='someone')), 1),
                                (dict(ISSUE, pull_request={"url": "pr"}), 1)]:
            with patch.object(gate, 'api', return_value=issue) as api:
                self.assertEqual(self.evaluate([RUN], pr)[0], expected)
                api.assert_called_once_with('repos/owner/repo/issues/1037')
        with patch.object(gate, 'api', return_value=ISSUE):
            self.assertEqual(self.evaluate([RUN], dict(PR, body='Fixes #1037'))[0], 0)
        with patch.object(gate, 'api') as api:
            self.assertEqual(self.evaluate([RUN], dict(PR, body='https://github.com/other/repo/issues/1'))[0], 1)
            api.assert_not_called()

    # test-category: security
    def test_fork_revert_branch_does_not_bypass(self):
        pr = dict(PR, head=dict(PR['head'], ref='fix/revert-pr-7-abc',
                               repo=dict(full_name='fork/repo')))
        self.assertEqual(self.evaluate([RUN], pr)[0], 1)

    # test-category: security
    def test_failed_issue_lookup_is_not_a_bypass(self):
        errors = [subprocess.CalledProcessError(1, ['gh', 'api'], stderr='HTTP 404'),
                  OSError('unavailable'), ValueError('invalid JSON')]
        for error in errors:
            with self.subTest(error=error), patch.object(gate, 'api', side_effect=error):
                result, output, _ = self.evaluate([RUN], dict(PR, body='see #999999'))
                self.assertEqual(result, 1)
                self.assertNotIn('::warning::', output)
        with patch.object(gate, 'api', side_effect=[errors[0], ISSUE]):
            self.assertEqual(self.evaluate([RUN], dict(PR, body='see #999999 and #1037'))[0], 0)

    # test-category: security
    def test_issue_must_match_each_failing_workflow(self):
        with patch.object(gate, 'main_workflows', return_value=['site.yml', 'rust-quality.yml']), \
             patch.object(gate, 'latest_main_run', side_effect=[RUN, dict(RUN, workflow_id=5)]), \
             patch.object(gate, 'api', return_value=ISSUE):
            self.assertEqual(gate.main_gate(dict(pull_request=dict(PR, body='see #1037')),
                                            REPO, 'pull_request'), 1)

    # test-category: security
    def test_current_workflow_failing_sha_evidence(self):
        issue = dict(ISSUE, body='<!-- main-ci-range:green:older -->\n<!-- workflow:4 -->'
                     f'Workflow green baseline: `green` → `{RUN["head_sha"]}`'
                     '<!-- /workflow:4 -->')
        with patch.object(gate, 'api', return_value=issue):
            self.assertEqual(self.evaluate([RUN], dict(PR, body='see #1037'))[0], 0)

    # test-category: pure-logic
    def test_api_error_warns_and_passes(self):
        result, output, _ = self.evaluate([], error=subprocess.CalledProcessError(1, ['gh', 'api'], stderr='HTTP 503'))
        self.assertEqual(result, 0)
        self.assertIn('::warning::', output)
        self.assertEqual(len(output.splitlines()), 1)

    # test-category: security
    def test_release_pr_and_non_pr_events_never_block(self):
        result, _, command = self.evaluate([RUN], dict(PR, base=dict(ref='release/1.0.0')))
        self.assertEqual(result, 0)
        command.assert_not_called()
        with patch.object(gate, 'command') as command:
            self.assertEqual(gate.main_gate({}, REPO, 'push'), 0)
            command.assert_not_called()

    # test-category: format-pin
    def test_main_workflows_include_all_current_push_coverage(self):
        self.assertEqual(set(gate.main_workflows()), {'rust-quality.yml', 'windows-preview-smoke.yml',
                         'native-deps.yml', 'site.yml', 'ds-site.yml'})

    # test-category: pure-logic
    def test_every_workflow_is_checked_independently(self):
        with patch.object(gate, 'main_workflows', return_value=['site.yml', 'rust-quality.yml']), \
             patch.object(gate, 'latest_main_run', side_effect=[dict(RUN, conclusion='success'), RUN]) as baseline:
            self.assertEqual(gate.main_gate(dict(pull_request=PR), REPO, 'pull_request'), 1)
            self.assertEqual(baseline.call_count, 2)

    # test-category: security
    def test_metadata_preserves_latest_full_quality_result(self):
        run = dict(id=12, run_attempt=2, display_title='CI #12', head_sha=PR['head']['sha'],
                   pull_requests=[dict(number=7)], status='completed')
        for conclusion in ['success', 'failure', 'skipped', 'cancelled']:
            jobs = dict(total_count=1, jobs=[dict(name='gate', steps=[dict(
                name='Require every selected check', conclusion=conclusion)])])
            with patch.object(gate, 'api', side_effect=[dict(workflow_runs=[run]), jobs]) as api:
                self.assertEqual(gate.quality_gate(dict(pull_request=PR), REPO), 0 if conclusion == 'success' else 1)
                self.assertIn(f'&head_sha={PR["head"]["sha"]}&', api.call_args_list[0].args[0])
        for update in [dict(status='in_progress'), dict(head_sha='old'),
                       dict(pull_requests=[dict(number=8)]), dict(display_title='Gate re-evaluation #12')]:
            with patch.object(gate, 'api', return_value=dict(workflow_runs=[dict(run, **update)])) as api:
                self.assertEqual(gate.quality_gate(dict(pull_request=PR), REPO), 1)
                api.assert_called_once()

    # test-category: format-pin
    def test_metadata_skips_changes_and_has_separate_concurrency(self):
        source = (Path(__file__).parent.parent / 'workflows/rust-quality.yml').read_text()
        self.assertIn('types: [opened, synchronize, reopened, labeled, unlabeled, edited]', source)
        changes = source.split('\n  changes:\n')[1].split('\n  windows-check:')[0]
        self.assertIn('!contains(fromJSON', changes)
        self.assertIn("format('rust-quality-metadata-{0}'", source)
        self.assertIn('Preserve existing quality result on metadata edits', source)


if __name__ == '__main__':
    unittest.main()
