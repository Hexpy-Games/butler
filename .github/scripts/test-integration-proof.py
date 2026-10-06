#!/usr/bin/env python3
"""Security/pure-logic checks for tag proof, receipt reuse and named waivers."""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('proof', ROOT / 'integration-proof.py')
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
branch_spec = importlib.util.spec_from_file_location('branch', ROOT / 'branch-name.py')
branch = importlib.util.module_from_spec(branch_spec)
branch_spec.loader.exec_module(branch)


class IntegrationProof(unittest.TestCase):
    # test-category: security
    def test_green_receipt_reused_missing_and_failed_cases(self):
        runs = [dict(head_sha='new', conclusion='success')]
        inputs = {'build': 'same', 'tests': 'fixed'}
        latest_failure = [dict(head_sha='new', conclusion='failure')] + runs
        self.assertEqual(proof.prove('ci.yml', 'new', inputs, latest_failure, [], lambda run: True), ['build', 'tests'])
        self.assertEqual(proof.prove('ci.yml', 'new', inputs, runs, [], lambda run: True), ['direct'])
        receipts = [dict(job_inputs=inputs, job_hashes={'build': 'same'}),
                    dict(job_inputs={'build': 'same', 'tests': 'old'}, job_hashes={'build': 'same', 'tests': 'old'})]
        self.assertEqual(proof.prove('ci.yml', 'new', inputs, [], receipts, lambda run: False), ['tests'])
        receipts[0]['job_hashes']['tests'] = 'fixed'
        self.assertEqual(proof.prove('ci.yml', 'new', inputs, [], receipts, lambda run: False), [])
        self.assertEqual(proof.prove('ci.yml', 'new', inputs, [], [], lambda run: False), ['build', 'tests'])
        self.assertEqual(proof.prove('ci.yml', 'new', inputs, runs, [], lambda run: False), ['build', 'tests'])

    # test-category: security
    def test_receipt_scope_and_failed_jobs_rerun_unchanged_jobs_reuse(self):
        run = dict(status='completed', conclusion='failure', event='push', head_branch='release/0.1.0-preview.11',
                   path='.github/workflows/rust-quality.yml', head_repository={'full_name': 'owner/repo'})
        self.assertTrue(proof.changes.trusted_run(run, 'owner/repo', None, 'rust-quality.yml', run['head_branch']))
        for update in [{'head_branch': 'main'}, {'event': 'pull_request'}, {'status': 'in_progress'},
                       {'head_repository': {'full_name': 'fork/repo'}}, {'path': '.github/workflows/other.yml'}]:
            self.assertFalse(proof.changes.trusted_run(dict(run, **update), 'owner/repo', None,
                                                     'rust-quality.yml', run['head_branch']))
        receipts = [dict(run=2, job_inputs={'build': 'same', 'tests': 'same'}, job_hashes={'build': 'same'}),
                    dict(run=1, job_inputs={'build': 'same', 'tests': 'same'}, job_hashes={'build': 'same', 'tests': 'same'})]
        with patch.object(proof.changes, 'previous', return_value=receipts):
            reused, jobs = proof.changes.reuse_inputs('owner/repo', None, 'rust-quality.yml', run['head_branch'],
                                                     {}, {'build': 'same', 'tests': 'same'})
        self.assertEqual(reused, {})
        self.assertEqual(jobs, {'build': 2})

    # test-category: security
    def test_preview_waiver_and_stable_owner_approval(self):
        entry = dict(kind='integration-waiver', candidate='0.1.0-preview.11', sha='sha', workflow='ci.yml',
                     job='tests', issue=123, reason='Known flaky; linked evidence')
        def accepted(update=None, login='coordinator', permission='write', opened=True, owner='owner'):
            record = dict(entry, **(update or {}))
            comment = dict(body=json.dumps(record), user={'login': login})
            return proof.waiver(comment, record['candidate'], 'sha', 'ci.yml', 'tests', 'owner/repo',
                                lambda number: opened, lambda login: permission, owner, ['coordinator'])
        self.assertTrue(accepted())
        comment = dict(body=json.dumps(entry), user={'login': 'other-writer'})
        self.assertFalse(proof.waiver(comment, entry['candidate'], 'sha', 'ci.yml', 'tests', 'owner/repo',
                                     lambda n: True, lambda login: 'write', 'owner', ['coordinator']))
        self.assertFalse(accepted(permission='read'))
        self.assertFalse(accepted(opened=False))
        self.assertFalse(accepted({'sha': 'other'}))
        self.assertFalse(accepted({'job': 'build'}))
        self.assertFalse(accepted({'issue': '123'}))
        self.assertFalse(accepted({'candidate': '0.1.0'}))
        self.assertTrue(accepted({'candidate': '0.1.0'}, login='owner'))
        self.assertFalse(accepted({'candidate': '0.1.0'}, login='owner', owner=''))

    # test-category: security
    def test_actual_check_requires_live_sha_and_rejects_missing_or_cancelled_waivers(self):
        workflows = {'ci.yml': 'gate', 'e2e.yml': 'E2E live tier'}
        def pages(path, key=None):
            if '/workflows/' in path:
                return [dict(id=1, run_attempt=1, status='completed', event='push', head_branch='release/0.1.0-preview.11',
                             path='.github/workflows/' + path.split('/workflows/')[1].split('/')[0],
                             head_repository={'full_name': 'owner/repo'}, head_sha='sha', conclusion='failure')]
            return [dict(name='gate', conclusion='success'), dict(name='E2E live tier', conclusion='failure')]
        receipt = dict(checkout='sha', job_inputs={'tests': 'hash'}, job_hashes={}, job_results={'tests': 'failure'})
        with patch.dict(proof.GATES, workflows, clear=True), patch.object(proof, 'pages', side_effect=pages), \
             patch.object(proof.changes, 'hashes', return_value={}), \
             patch.object(proof.changes, 'integration_inputs', return_value={'tests': 'hash'}), \
             patch.object(proof.changes, 'previous', return_value=[receipt]), \
             patch.object(proof, 'waived', return_value=True) as approval:
            proof.check('owner/repo', '0.1.0-preview.11', 'sha')
            self.assertEqual(approval.call_count, 2)
            receipt['job_results']['tests'] = 'cancelled'
            with self.assertRaisesRegex(ValueError, 'ci.yml/tests'):
                proof.check('owner/repo', '0.1.0-preview.11', 'sha')
            receipt['job_inputs'] = {}
            with self.assertRaisesRegex(ValueError, 'ci.yml/tests'):
                proof.check('owner/repo', '0.1.0-preview.11', 'sha')

    # test-category: security
    def test_only_failed_matrix_jobs_rerun_and_can_be_waived(self):
        parts = proof.changes.ci_parts
        inputs = {job: 'hash' for job in parts.inventory('rust-quality.yml')}
        complete = {f'{job}/{part}': 'hash' for job, names in parts.inventory('rust-quality.yml').items() for part in names}
        failed = 'linux-perf/perf-idle'
        receipt = dict(run=1, job_inputs=inputs, part_hashes=dict(complete),
                       part_results={key: 'success' for key in complete})
        receipt['part_hashes'].pop(failed)
        receipt['part_results'][failed] = 'failure'
        selected, reuse, artifacts = parts.select('rust-quality.yml', inputs, [receipt])
        self.assertEqual(selected['linux-perf']['perf'], ['idle'])
        self.assertFalse(selected['linux-tests']['workspace'])
        self.assertEqual(selected['linux-tests']['e2e'], [])
        self.assertEqual(len(reuse), len(complete) - 1)
        self.assertEqual(proof.failed_parts('rust-quality.yml', 'linux-perf', inputs, [receipt]), [failed])
        inputs = {job: 'changed' for job in inputs}
        selected, reuse, _ = parts.select('rust-quality.yml', inputs, [receipt])
        self.assertEqual(reuse, {})
        self.assertEqual(selected['linux-perf']['perf'], parts.PERF)
        self.assertEqual(selected['linux-tests']['e2e'], parts.E2E)
        actual = [dict(name='linux-perf / Performance (linux-x64 idle)', conclusion='failure'),
                  dict(name='linux-tests / E2E (linux-x64 ins-02)', conclusion='success')]
        state = dict(workflow='rust-quality.yml', job_inputs=inputs, part_reuse={'macos-perf/perf-1': 1})
        recorded = parts.record(state, actual)
        self.assertNotIn(failed, recorded['part_hashes'])
        self.assertEqual(recorded['part_hashes']['linux-tests/e2e-ins-02'], 'changed')
        self.assertEqual(recorded['part_hashes']['macos-perf/perf-1'], 'changed')

    # test-category: security
    def test_windows_partial_matrix_restores_complete_evidence(self):
        parts = proof.changes.ci_parts
        receipt = dict(run=7, job_inputs={'hosted': 'hash'},
                       part_hashes={f'hosted/{name}': 'hash' for name in ['remote', 'recovery', 'basics']},
                       part_results={f'hosted/{item["shard"]}': 'failure' if item['shard'] == 'data' else 'success' for item in parts.HOSTED})
        selected, reused, artifacts = parts.select('windows-preview-smoke.yml', {'hosted': 'hash'}, [receipt])
        self.assertEqual(selected['hosted'], [parts.HOSTED[2]])
        self.assertEqual(len(reused), 3)
        self.assertEqual({artifact['name'] for artifact in artifacts},
                         {'windows-completed-remote', 'windows-completed-recovery', 'windows-completed-basics'})
        self.assertEqual(parts.key_for_name('Hosted Windows E2E (data)'), 'hosted/data')

    # test-category: pure-logic
    def test_branch_names(self):
        for name in ['ci/git-flow', 'feat/chat', 'fix/0.1.0-preview.11-startup', 'release/0.1.0', 'release/0.1.0-preview.11']:
            self.assertTrue(branch.valid(name), name)
        for name in ['codex/git-flow', 'claude/fix', 'batch/preview-11', 'main', 'foo/bar', 'ci/a/b', 'release/latest', 'dependabot/npm/foo']:
            self.assertFalse(branch.valid(name), name)


if __name__ == '__main__':
    unittest.main()
