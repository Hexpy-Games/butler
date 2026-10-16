"""Downstream Windows jobs need a successful or rehydrated producer."""
import itertools
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parent


class WindowsCascade(unittest.TestCase):
    # test-category: pure-logic
    def test_downstream_producer_truth_tables(self):
        source = (ROOT.parent / 'workflows/windows-preview-smoke.yml').read_text()
        results = ('success', 'failure', 'cancelled', 'skipped')
        for job in ('release', 'hosted'):
            block = source.split(f'\n  {job}:\n')[1].split('\n    needs:')[0]
            expression = re.search(r'^    if: (.*)$', block, re.M)[1]
            for stub, build, stub_artifact, build_artifact, selected, cancelled, changes in itertools.product(
                    results, results, (False, True), (False, True), (False, True), (False, True), results):
                values = {'always()': True, 'cancelled()': cancelled,
                          'needs.changes.result': changes,
                          'needs.stub.result': stub, 'needs.build.result': build,
                          "contains(fromJSON(needs.changes.outputs.artifacts).*.name, 'windows-e2e')": stub_artifact,
                          "contains(fromJSON(needs.changes.outputs.artifacts).*.name, 'agent-windows-x64')": build_artifact,
                          'needs.changes.outputs.tier': 'integration',
                          f"fromJSON(needs.changes.outputs.jobs)['{job}']": selected,
                          'inputs.native-loop': False, 'github.event_name': 'push'}
                condition = expression
                for name, value in values.items():
                    condition = condition.replace(name, repr(value))
                condition = re.sub(r'!(?!=)', 'not ', condition).replace('&&', 'and').replace('||', 'or')
                ready = stub == 'success' or (stub == 'skipped' and stub_artifact)
                if job == 'release':
                    ready &= build == 'success' or (build == 'skipped' and build_artifact)
                expected = not cancelled and changes == 'success' and selected and ready
                self.assertEqual(bool(eval(condition, {'__builtins__': {}})), expected,
                                 (job, stub, build, stub_artifact, build_artifact, selected, cancelled, changes))

    # test-category: pure-logic
    def test_gate_keeps_failed_producer_red_when_consumers_skip(self):
        for producer in ('build', 'stub'):
            jobs = {name: dict(result='skipped') for name in ('build', 'stub', 'release', 'hosted')}
            jobs[producer]['result'] = 'failure'
            jobs['changes'] = dict(result='success', outputs=dict(tier='integration', jobs=json.dumps(
                {name: name == producer for name in ('build', 'stub', 'release', 'hosted')})))
            env = dict(os.environ, RESULTS=json.dumps(jobs), CHECK_GROUPS=json.dumps(
                {name: 'jobs' for name in ('build', 'stub', 'release', 'hosted')}))
            result = subprocess.run([sys.executable, ROOT / 'ci-check-selected.py'], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(producer, result.stderr.decode())
