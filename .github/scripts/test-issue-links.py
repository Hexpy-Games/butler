#!/usr/bin/env python3
"""Fixture tests for PR issue-link checks and release-branch issue closing."""
import unittest
from unittest.mock import patch

import issue_links as links

REPO = 'owner/repo'
ISSUE = dict(state='open')
PULL = dict(state='open', pull_request={'url': 'pr'})
MERGED = dict(number=9, title='fix: crash', body='Fixes #4', merged_at='today',
              base={'ref': 'release/1.2.3'})


class IssueLinks(unittest.TestCase):
    # test-category: pure-logic
    def test_closing_and_non_closing_tokens_follow_github_forms(self):
        body = ('Fixes #1\ncloses: #2, resolved #3\nFIXED #4 and #5\nRefs #6\n'
                'Part of #7\nrelated: #8\nPART OF: #13\nSee other/repo#9 and `#10`\n'
                '<!-- e.g. Fixes #11 -->\n#12a\nFixes owner/repo#14\r\n'
                'fixes https://github.com/owner/repo/issues/15\r\n'
                'Fixes other/repo#16 and https://github.com/other/repo/issues/17\n'
                'mentions owner/repo#18 and https://github.com/owner/repo/issues/19\n')
        closed, conflicts, loose = links.references(REPO, body)
        self.assertEqual(closed, {1, 2, 3, 4, 14, 15})
        self.assertEqual(conflicts, set())
        self.assertEqual(loose, {5, 6, 18, 19})

    # test-category: pure-logic
    def test_code_blocks_are_not_references(self):
        body = ('Text\n\n```sh\n#1\n```\n~~~\nFixes #2\n~~~\n\n    #3 indented code\n\tFixes #4\n\n'
                'After #5\n- item\n    Fixes #6\n')
        closed, _, loose = links.references(REPO, body)
        self.assertEqual((closed, loose), ({6}, {5}))

    # test-category: pure-logic
    def test_closing_and_non_closing_for_one_issue_is_a_conflict(self):
        closed, conflicts, loose = links.references(REPO, 'Fixes #3\nPart of #3\nFixes #4\nRelated #5\n#5')
        self.assertEqual((closed, conflicts, loose), ({4}, {3}, set()))

    # test-category: pure-logic
    def test_check_flags_conflicts_and_unlinked_issues_not_prs_or_missing(self):
        records = {5: ISSUE, 6: PULL, 7: None, 8: dict(state='closed')}
        with patch.object(links, 'issue', side_effect=lambda _, n: records[n]):
            self.assertEqual(links.problems(REPO, 'Refs #5, #6, #7, #8'), ([], [5, 8]))
            self.assertEqual(links.problems(REPO, 'Fixes #5\nPart of #8'), ([], []))
            self.assertEqual(links.problems(REPO, 'Fixes #5\nRelated #5'), ([5], []))
        self.assertEqual(links.problems(REPO, 'No issues here.'), ([], []))
        self.assertEqual(links.problems(REPO, None), ([], []))

    # test-category: security
    def test_release_merge_closes_open_issues_and_skips_prs_closed_and_conflicts(self):
        pr = dict(MERGED, title='Resolve #3', body='Fixes #4\nFixes #5\nFixes #6\nRefs #7\nFixes #8\nPart of #8')
        records = {3: ISSUE, 4: ISSUE, 5: PULL, 6: dict(state='closed'), 8: ISSUE}
        with patch.object(links, 'issue', side_effect=lambda _, n: records[n]), \
             patch.object(links, 'api') as api:
            self.assertEqual(links.close_release_fixes(REPO, pr), [3, 4])
        calls = [call.args for call in api.call_args_list]
        self.assertEqual(calls, [
            ('repos/owner/repo/issues/3/comments', 'POST', {'body': 'Fixed by #9 on release/1.2.3.'}),
            ('repos/owner/repo/issues/3', 'PATCH', {'state': 'closed', 'state_reason': 'completed'}),
            ('repos/owner/repo/issues/4/comments', 'POST', {'body': 'Fixed by #9 on release/1.2.3.'}),
            ('repos/owner/repo/issues/4', 'PATCH', {'state': 'closed', 'state_reason': 'completed'}),
        ])

    # test-category: security
    def test_unmerged_or_non_release_prs_never_write(self):
        for pr in [dict(MERGED, merged_at=None), dict(MERGED, base={'ref': 'main'})]:
            with patch.object(links, 'issue') as lookup, patch.object(links, 'api') as api:
                self.assertEqual(links.close_release_fixes(REPO, pr), [])
                lookup.assert_not_called()
                api.assert_not_called()


if __name__ == '__main__':
    unittest.main()
