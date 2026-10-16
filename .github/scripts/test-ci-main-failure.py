#!/usr/bin/env python3
"""Fixture tests for main failure ranges and draft-only revert follow-up."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import ci_main_failure as failure

REPO = 'owner/repo'
RUN = dict(id=10, workflow_id=4, run_attempt=1, name='Rust quality', head_sha='bad',
           html_url='https://example.invalid/run/10', event='push', head_branch='main',
           conclusion='failure', repository={'full_name': REPO}, head_repository={'full_name': REPO})
PR = dict(number=7, html_url='https://example.invalid/pull/7', merged_at='today',
          merge_commit_sha='merge', base={'ref': 'main', 'repo': {'full_name': REPO}})


class Followup(unittest.TestCase):
    # test-category: pure-logic
    def test_last_green_is_scoped_to_workflow_and_main_ancestor(self):
        runs = [dict(RUN, id=11, status='completed', conclusion='success', head_sha='new'),
                dict(RUN, id=9, status='completed', conclusion='failure'),
                dict(RUN, id=8, status='completed', conclusion='success', head_sha='green')]
        with patch.object(failure, 'pages', return_value=runs) as pages, \
             patch.object(failure.subprocess, 'call', return_value=0), \
             patch.object(failure, 'git', return_value='merge\nfix') as git:
            self.assertEqual(failure.failure_range(REPO, RUN), ('green', ['merge', 'fix']))
        self.assertIn('/workflows/4/runs?branch=main&event=push', pages.call_args.args[0])
        git.assert_called_once_with('rev-list', '--first-parent', '--reverse', 'green..bad')

    # test-category: pure-logic
    def test_real_first_parent_range_excludes_feature_branch_commits(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(['git', '-C', directory, *args], text=True).strip()
            git('init', '-q', '-b', 'main')
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            git('commit', '--allow-empty', '-qm', 'green')
            green = git('rev-parse', 'HEAD')
            git('switch', '-qc', 'feature')
            git('commit', '--allow-empty', '-qm', 'feature')
            git('switch', '-q', 'main')
            git('merge', '--no-ff', '-qm', 'merge', 'feature')
            head = git('rev-parse', 'HEAD')
            prior = dict(RUN, id=1, status='completed', conclusion='success', head_sha=green)
            with patch.object(failure, 'pages', return_value=[prior]), \
                 patch.object(failure, 'git', side_effect=git), \
                 patch.object(failure.subprocess, 'call', return_value=0):
                self.assertEqual(failure.failure_range(REPO, dict(RUN, head_sha=head)), (green, [head]))

    # test-category: pure-logic
    def test_merge_pr_mapping_and_ready_revert_commands(self):
        with patch.object(failure, 'git', return_value='merge parent1 parent2'), \
             patch.object(failure, 'pages', return_value=[PR]):
            merges, prs = failure.range_prs(REPO, ['merge'])
        body = failure.issue_body(RUN, 'green', ['merge'], merges, prs,
                                  [dict(name='workspace', html_url='job-url', conclusion='failure')], 'marker')
        self.assertEqual(merges, [('merge', 7)])
        for expected in ['git revert -m 1 merge', '#7', 'job-url', 'green', 'bad']:
            self.assertIn(expected, body)

    # test-category: security
    def test_single_pr_creates_draft_and_multi_pr_never_mutates(self):
        with patch.object(failure, 'pages', return_value=[]), \
             patch.object(failure, 'git', return_value='') as git, \
             patch.object(failure, 'api') as api:
            failure.draft_revert(REPO, RUN, [('merge', 7)], {7: PR}, 'marker', 'body')
            data = api.call_args.args[2]
            self.assertTrue(data['draft'])
            self.assertTrue(data['head'].startswith('revert/'))
            self.assertEqual(data['base'], 'main')
            self.assertTrue(any('revert' in call.args for call in git.call_args_list))
            git.reset_mock()
            api.reset_mock()
            failure.draft_revert(REPO, RUN, [('merge', 7), ('other', 8)], {7: PR, 8: PR}, 'marker', 'body')
            git.assert_not_called()
            api.assert_not_called()

    # test-category: security
    def test_issue_range_and_revert_pr_deduplicate(self):
        marker = '<!-- main-ci-range:green:bad -->'
        def pages(path):
            return ([dict(number=2, body=marker)] if '/issues?' in path else
                    [dict(name='test', html_url='job-url', conclusion='failure')])
        with patch.object(failure, 'failure_range', return_value=('green', ['merge'])), \
             patch.object(failure, 'range_prs', return_value=([('merge', 7)], {7: PR})), \
             patch.object(failure, 'pages', side_effect=pages), \
             patch.object(failure, 'api') as api, patch.object(failure, 'draft_revert'):
            failure.report(REPO, RUN)
            self.assertEqual(api.call_args.args[:2], ('repos/owner/repo/issues/2', 'PATCH'))
        with patch.object(failure, 'pages', return_value=[dict(number=3)]), \
             patch.object(failure, 'git') as git, patch.object(failure, 'api') as api:
            failure.draft_revert(REPO, RUN, [('merge', 7)], {7: PR}, marker, 'body')
            git.assert_not_called()
            api.assert_not_called()

    # test-category: security
    def test_forks_and_non_main_events_cannot_write(self):
        for update in [dict(event='pull_request'), dict(head_branch='feature'),
                       dict(head_repository={'full_name': 'fork/repo'}), dict(conclusion='success')]:
            with patch.object(failure, 'failure_range') as ranges, patch.object(failure, 'pages', return_value=[]):
                failure.report(REPO, dict(RUN, **update))
                ranges.assert_not_called()

    # test-category: security
    def test_same_range_across_workflows_updates_one_issue_preserving_evidence(self):
        marker = '<!-- main-ci-range:green:bad -->'
        previous = marker + '\n<!-- workflow:3 -->earlier failure<!-- /workflow:3 -->'
        def pages(path):
            if '/issues?' in path:
                return [dict(number=2, body=previous)]
            return [dict(name='test', html_url='job-url', conclusion='failure')]
        with patch.object(failure, 'failure_range', return_value=('green', ['merge'])), \
             patch.object(failure, 'range_prs', return_value=([('merge', 7)], {7: PR})), \
             patch.object(failure, 'pages', side_effect=pages), \
             patch.object(failure, 'api') as api, patch.object(failure, 'draft_revert') as revert:
            failure.report(REPO, RUN)
            self.assertEqual(api.call_args.args[:2], ('repos/owner/repo/issues/2', 'PATCH'))
            self.assertIn('earlier failure', api.call_args.args[2]['body'])
            self.assertIn('<!-- workflow:4 -->', api.call_args.args[2]['body'])
            self.assertEqual(revert.call_args.args[4], marker)

    # test-category: pure-logic
    def test_cancelled_run_with_failed_job_and_missing_baseline_still_reports(self):
        def pages(path):
            return [] if '/issues?' in path else [dict(name='failed', html_url='job-url', conclusion='failure')]
        with patch.object(failure, 'failure_range', side_effect=ValueError('No green baseline')), \
             patch.object(failure, 'pages', side_effect=pages), patch.object(failure, 'api') as api, \
             patch.object(failure, 'git') as git:
            failure.report(REPO, dict(RUN, conclusion='cancelled'))
            self.assertEqual(api.call_args.args[1], 'POST')
            self.assertIn('No proven green baseline', api.call_args.args[2]['body'])
            git.assert_not_called()


if __name__ == '__main__':
    unittest.main()
