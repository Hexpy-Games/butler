#!/usr/bin/env python3
"""Same-PR receipts, merged-tree invalidation and gate success fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import ci_receipts

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('smoke_changes', ROOT / 'ci-changes.py')
changes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changes)
REPO = 'owner/repo'
WORKFLOW = 'rust-quality.yml'
PR = dict(number=12, head=dict(ref='fix/example', sha='head', repo=dict(full_name=REPO)),
          base=dict(ref='main', sha='base', repo=dict(full_name=REPO)))
RUN = dict(id=1, run_attempt=1, status='completed', conclusion='success', event='pull_request',
           path='.github/workflows/' + WORKFLOW, head_branch='fix/example', head_sha='head',
           head_repository=dict(full_name=REPO), pull_requests=[dict(number=12)])


def receipt():
    current = dict.fromkeys(changes.GROUPS, 'hash')
    inputs = ci_receipts.smoke_inputs(WORKFLOW, current, changes.job_groups(WORKFLOW), lambda *a: 'tree')
    return dict(schema=1, repository=REPO, workflow=WORKFLOW, pr=12, run=1, tier='smoke',
                branch='fix/example', base_ref='main', head_repository=REPO, head='head',
                job_inputs=inputs, job_hashes=inputs, job_results=dict.fromkeys(inputs, 'success'))


class SmokeReuse(unittest.TestCase):
    # test-category: security
    def test_run_and_receipt_identity_reject_forks_other_prs_and_failures(self):
        self.assertTrue(ci_receipts.trusted_run(RUN, REPO, 12, WORKFLOW, 'fix/example'))
        for update in [dict(conclusion='failure'), dict(conclusion='cancelled'), dict(status='in_progress'),
                       dict(head_repository=dict(full_name='fork/repo')), dict(pull_requests=[dict(number=13)]),
                       dict(head_branch='fix/other')]:
            self.assertFalse(ci_receipts.trusted_run(dict(RUN, **update), REPO, 12, WORKFLOW, 'fix/example'))
        state = receipt()
        for update in [dict(pr=13), dict(head_repository='fork/repo'), dict(base_ref='release/1.0.0'),
                       dict(branch='fix/other'), dict(head='other')]:
            self.assertFalse(ci_receipts.receipt_scope(dict(state, **update), RUN, REPO, 12,
                                                      WORKFLOW, 'fix/example', 'main'))

    # test-category: pure-logic
    def test_same_pr_repush_reuses_jobs_but_changed_inputs_rerun(self):
        state = receipt()
        for changed, expected in [(False, False), (True, True)]:
            with tempfile.TemporaryDirectory() as directory:
                env = dict(GITHUB_EVENT_NAME='pull_request', GITHUB_REF='refs/pull/12/merge',
                           GITHUB_REPOSITORY=REPO, GITHUB_RUN_ID='2',
                           GITHUB_OUTPUT=directory + '/out', GITHUB_STEP_SUMMARY=directory + '/summary')
                current = dict.fromkeys(changes.GROUPS, 'hash')
                if changed:
                    current['rust'] = 'changed-on-merge-result'
                with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='tree'), \
                     patch.object(changes, 'changed', return_value=['packages/butler-agent/rust/crates/butler-core/src/lib.rs']), \
                     patch.object(changes, 'hashes', return_value=current), \
                     patch.object(changes, 'previous', return_value=[state]) as previous:
                    changes.select({'pull_request': PR}, WORKFLOW)
                previous.assert_called_once_with(REPO, 12, WORKFLOW, 'fix/example', 'main')
                outputs = dict(line.split('=', 1) for line in Path(env['GITHUB_OUTPUT']).read_text().splitlines())
                jobs = json.loads(outputs['jobs'])
                self.assertEqual(jobs['linux-clippy'], expected)
                self.assertEqual(jobs['linux-tests'], expected)
                results = dict(changes=dict(result='success', outputs=outputs))
                results.update({name: dict(result='success' if selected else 'skipped') for name, selected in jobs.items()})
                check = subprocess.run(['python3', ROOT / 'check-gate.py'],
                                       env=dict(os.environ, RESULTS=json.dumps(results)), capture_output=True)
                self.assertEqual(check.returncode, 0, check.stderr)
                selected_state = json.loads(outputs['selection'])
                with patch.dict(os.environ, RESULTS=json.dumps(results), RUNNER_TEMP=directory,
                                JOB_GROUPS=json.dumps({'rust': ['linux-clippy']})):
                    changes.record()
                written = json.loads((Path(directory) / 'ci-inputs/inputs.json').read_text())
                self.assertEqual(written['job_hashes']['linux-clippy'], selected_state['job_inputs']['linux-clippy'])

    # test-category: security
    def test_current_fork_never_attempts_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            env = dict(GITHUB_EVENT_NAME='pull_request', GITHUB_REF='refs/pull/12/merge',
                       GITHUB_REPOSITORY=REPO, GITHUB_RUN_ID='2', GITHUB_OUTPUT=directory+'/out',
                       GITHUB_STEP_SUMMARY=directory+'/summary')
            pr = dict(PR, head=dict(PR['head'], repo=dict(full_name='fork/repo')))
            with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='tree'), \
                 patch.object(changes, 'changed', return_value=['Cargo.toml']), \
                 patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')), \
                 patch.object(changes, 'previous') as previous:
                changes.select({'pull_request': pr}, WORKFLOW)
                previous.assert_not_called()

    # test-category: security
    def test_failed_or_partial_job_receipts_do_not_reuse(self):
        for result in ['failure', 'cancelled', None, 'skipped']:
            state = receipt()
            state['job_results']['linux-clippy'] = result
            _, reused = changes.reuse_inputs(REPO, 12, WORKFLOW, 'fix/example', {},
                                             state['job_inputs'], receipts=[state])
            self.assertNotIn('linux-clippy', reused)

    # test-category: pure-logic
    def test_job_hash_covers_script_workflow_and_merged_group_inputs(self):
        current = dict.fromkeys(changes.GROUPS, 'hash')
        groups = changes.job_groups(WORKFLOW)
        baseline = ci_receipts.smoke_inputs(WORKFLOW, current, groups, lambda *a: 'tree')
        plumbing = ci_receipts.smoke_inputs(WORKFLOW, current, groups, lambda *a: 'changed-script')
        self.assertNotEqual(baseline['linux-clippy'], plumbing['linux-clippy'])
        changed = ci_receipts.smoke_inputs(WORKFLOW, dict(current, rust='base-moved'), groups, lambda *a: 'tree')
        self.assertNotEqual(baseline['linux-tests'], changed['linux-tests'])
        ui = ci_receipts.smoke_inputs(WORKFLOW, dict(current, ui='new-ui'), groups, lambda *a: 'tree')
        self.assertEqual(baseline['linux-clippy'], ui['linux-clippy'])

    # test-category: security
    def test_discovery_requires_successful_receipt_publication(self):
        state = receipt()
        for publication in ['success', 'failure', 'cancelled', None]:
            def items(path, key):
                return dict(workflow_runs=[RUN], artifacts=[dict(name='ci-inputs-'+WORKFLOW+'-1', expired=False)],
                            jobs=[dict(steps=[dict(name='Publish successful inputs', conclusion=publication)])])[key]
            def download(args, **kwargs):
                (Path(args[-1]) / 'inputs.json').write_text(json.dumps(state))
            with patch.object(ci_receipts.subprocess, 'run', side_effect=download):
                found = list(ci_receipts.previous(REPO, 12, WORKFLOW, 'fix/example', 'main', items))
                self.assertEqual(bool(found), publication == 'success')


if __name__ == '__main__':
    unittest.main()
