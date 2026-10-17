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
    def test_closing_keywords_follow_github_forms(self):
        body = ('Fixes #1\ncloses: #2, resolved #3\nFIXED #4 and #5\nRefs #6\n'
                'Part of #7\nSee owner/other#8 and `#9`\n<!-- e.g. Fixes #10 -->\n```\n#11\n```\n#12a')
        closed, loose = links.references(body)
        self.assertEqual(closed, {1, 2, 3, 4})
        self.assertEqual(loose, {5, 6})

    # test-category: pure-logic
    def test_check_flags_only_open_or_closed_issues_not_prs_or_missing(self):
        records = {5: ISSUE, 6: PULL, 7: None, 8: dict(state='closed')}
        with patch.object(links, 'issue', side_effect=lambda _, n: records[n]):
            self.assertEqual(links.unlinked_issues(REPO, 'Refs #5, #6, #7, #8'), [5, 8])
            self.assertEqual(links.unlinked_issues(REPO, 'Fixes #5\nPart of #8'), [])
        self.assertEqual(links.unlinked_issues(REPO, 'No issues here.'), [])
        self.assertEqual(links.unlinked_issues(REPO, None), [])

    # test-category: security
    def test_release_merge_closes_open_issues_and_skips_prs_and_closed(self):
        pr = dict(MERGED, title='Resolve #3', body='Fixes #4\nFixes #5\nFixes #6\nRefs #7')
        records = {3: ISSUE, 4: ISSUE, 5: PULL, 6: dict(state='closed')}
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
