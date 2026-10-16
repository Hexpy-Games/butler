#!/usr/bin/env python3
"""Pin fixture producer/consumer selection and manual macOS update proof."""
import importlib.util
import itertools
import json
from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from ci_consumer_test_support import jobs

SPEC = importlib.util.spec_from_file_location('fixture_changes', Path(__file__).with_name('ci-changes.py'))
changes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changes)

WORKFLOWS = Path(__file__).resolve().parents[1] / 'workflows'


def workflow(name):
    return (WORKFLOWS / (name + '.yml')).read_text()


def expression(source, key):
    return re.search(r'^\s+' + re.escape(key) + r': \$\{\{ (.*) \}\}$', source, re.M)[1]


def evaluate(condition, values):
    for key, value in values.items():
        condition = condition.replace(key, repr(value))
    return eval(condition.replace('&&', ' and ').replace('||', ' or '), {'__builtins__': {}})


class FixtureScope(unittest.TestCase):
    # test-category: format-pin
    def test_perf_fixture_matches_selected_integration_consumer(self):
        callers = jobs(workflow('rust-quality'))
        for platform, target in [('linux', 'linux-x64'), ('linux-arm64', 'linux-arm64'),
                                 ('macos', 'darwin-arm64')]:
            producer, consumer = callers[platform + '-native'], callers[platform + '-perf']
            condition = expression(producer, 'perf-fixture')
            for tier in ['smoke', 'integration']:
                for selected in [False, True]:
                    values = {'needs.changes.outputs.tier': tier,
                              "fromJSON(needs.changes.outputs.jobs)['" + platform + "-perf']": selected}
                    expected = tier == 'integration' and selected
                    self.assertEqual(evaluate(condition, values), expected, (platform, tier, selected))
                    consumer_if = re.search(r'^    if: (.*)$', consumer, re.M)[1]
                    values.update({'always()': True, '!cancelled()': True,
                                   'needs.changes.result': 'success'})
                    self.assertEqual(evaluate(consumer_if, values), expected)
            self.assertIn(platform + '-native', consumer.split('    if:')[0])
            self.assertIn('      platform: ' + target, consumer)
            self.assertIn('      performance-only: true', consumer)
        native = workflow('native-agent')
        self.assertIn('      perf-fixture:\n        type: boolean\n        default: false', native)
        fixture = native.split('      - name: Build the perf E2E agent')[1].split('      - name:')[0]
        self.assertIn('        if: inputs.perf-fixture', fixture)
        upload = native.split('          name: agent-perf-fixture-')[0].rsplit('      - uses:', 1)[1]
        self.assertIn('        if: inputs.perf-fixture', upload)
        commands = re.findall(r'^          python3 .* cargo build .*$', native, re.M)
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0], commands[1].replace('$feature,e2e-fixtures', '$feature'))
        production = native.split('      - name: Build the production configuration once')[1].split('      - name:')[0]
        self.assertNotIn('        if:', production)
        perf = jobs(workflow('rust-tests'))['perf']
        self.assertIn('name: agent-perf-fixture-${{ inputs.platform }}', perf)
        self.assertIn('agent-binary: ${{ runner.temp }}/perf-agent/butler-agent', perf)

    def select_run(self, run, receipts):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            env = dict(GITHUB_EVENT_NAME='push', GITHUB_REF='refs/heads/release/0.1.0',
                       GITHUB_REPOSITORY='owner/repo', GITHUB_RUN_ID=str(run),
                       GITHUB_OUTPUT=str(output), GITHUB_STEP_SUMMARY=str(Path(directory) / 'summary'))
            with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='checkout'), \
                 patch.object(changes, 'previous', return_value=iter(receipts)), \
                 patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
                changes.select({}, 'rust-quality.yml')
            values = dict(line.split('=', 1) for line in output.read_text().splitlines())
            return json.loads(values['selection'])

    # test-category: pure-logic
    def test_integration_reuses_native_and_perf_only_as_a_pair(self):
        inputs = self.select_run(1, [])['job_inputs']
        for platform, native, perf in itertools.product(
                ['linux', 'linux-arm64', 'macos'], [False, True], [False, True]):
            pair = [platform + '-native', platform + '-perf']
            passed = {name: inputs[name] for name, success in zip(pair, [native, perf]) if success}
            receipt = dict(run=1, job_inputs=inputs, job_hashes=passed)
            state = self.select_run(2, [receipt])
            selected = json.loads(state['outputs']['jobs'])
            with self.subTest(platform=platform, native=native, perf=perf):
                for name in pair:
                    self.assertEqual(selected[name], not (native and perf))
                    self.assertEqual(name in state['job_reuse'], native and perf)

    # test-category: pure-logic
    def test_failed_native_then_successful_rerun_needs_no_old_fixture(self):
        history, artifacts = [], {}
        callers = jobs(workflow('rust-quality'))
        for run in [1, 2, 3]:  # Y fails native after upload; S succeeds; T reuses S.
            state = self.select_run(run, history)
            selected = json.loads(state['outputs']['jobs'])
            artifacts[run] = set()
            for platform, target in [('linux', 'linux-x64'), ('linux-arm64', 'linux-arm64'),
                                     ('macos', 'darwin-arm64')]:
                native, perf = platform + '-native', platform + '-perf'
                self.assertEqual(selected[native], run != 3)
                self.assertEqual(selected[perf], run != 3)
                enabled = evaluate(expression(callers[native], 'perf-fixture'), {
                    'needs.changes.outputs.tier': 'integration',
                    "fromJSON(needs.changes.outputs.jobs)['" + perf + "']": selected[perf]})
                if selected[native]:
                    artifacts[run].add('agent-payload-' + target)
                    if enabled:
                        artifacts[run].add('agent-perf-fixture-' + target)
                if selected[perf]:
                    self.assertIn('agent-perf-fixture-' + target, artifacts[run])
            for artifact in json.loads(state['outputs']['artifacts']):
                self.assertNotIn('agent-perf-fixture-', artifact['name'])
                self.assertIn(artifact['name'], artifacts[artifact['run']])
            passed = {name: digest for name, digest in state['job_inputs'].items()
                      if not (run == 1 and name.endswith('-native'))
                      and (name.endswith('-native') or name.endswith('-perf'))}
            history.insert(0, dict(run=run, job_inputs=state['job_inputs'], job_hashes=passed))

    # test-category: format-pin
    def test_manual_update_source_download_and_release_contract(self):
        source = workflow('macos-app-package')
        dispatch, call = source.split('  workflow_call:', 1)
        self.assertIn('      update-agent-run-id:', dispatch)
        self.assertNotIn('      update-agent-run-id:', call)
        download = source.split('      - name: Download manually selected update-fixture agents')[1].split('      - name:')[0]
        self.assertIn("if: github.event_name == 'workflow_dispatch' && inputs.update-agent-run-id != ''", download)
        for value in ['uses: actions/download-artifact@v4', 'name: macos-update-agent-builds',
                      'run-id: ${{ inputs.update-agent-run-id }}', 'github-token: ${{ github.token }}',
                      'path: ${{ runner.temp }}/update-agent-builds']:
            self.assertIn(value, download)
        self.assertIn("if: inputs.update-agent-artifact != ''\n        with:\n          name: ${{ inputs.update-agent-artifact }}", source)
        use = source.split('      - name: Use the real prebuilt update-fixture versions')[1].split('      - name:')[0]
        self.assertIn('BUTLER_UPDATE_SMOKE_AGENT_BUILDS=$RUNNER_TEMP/update-agent-builds', use)
        condition = expression(source, 'MANUAL_WITHOUT_UPDATE_FIXTURES')
        for event, caller, run, skip in [
            ('workflow_dispatch', 'macOS App package', '', True),
            ('workflow_dispatch', 'macOS App package', '123', False),
            ('push', 'Rust quality', '', False),
            ('workflow_dispatch', 'Rust quality', '', False),
        ]:
            self.assertEqual(evaluate(condition, {'github.event_name': event,
                             'github.workflow': caller, 'inputs.update-agent-run-id': run}), skip)
        # Other visual smokes and the packaged update proof remain unconditional
        # within their existing !published-candidate steps.
        visual = source.split('      - name: Compare new-chat surfaces')[1].split('      - name:')[0]
        guard = visual.split('          if [ "$MANUAL_WITHOUT_UPDATE_FIXTURES"')[1].split('          fi', 1)[0]
        self.assertEqual(re.findall(r'tests/smoke/[\w.-]+', guard), ['tests/smoke/app-update-work-stream.ts'])
        packaged = source.split('      - name: Packaged preview App update through Settings')[1].split('      - name:')[0]
        self.assertIn('if: ${{ !inputs.published-candidate }}', packaged)
        self.assertIn('for scenario in idle now defer background-quit', packaged)
        self.assertNotIn('MANUAL_WITHOUT_UPDATE_FIXTURES', packaged)

    # test-category: pure-logic
    def test_update_guard_warns_only_for_manual_missing_source_and_fails_closed(self):
        source = workflow('macos-app-package')
        block = source.split('          if [ "$MANUAL_WITHOUT_UPDATE_FIXTURES"')[1].split('          fi', 1)[0]
        script = 'if [ "$MANUAL_WITHOUT_UPDATE_FIXTURES"' + block + 'fi\n'
        with tempfile.TemporaryDirectory() as directory:
            runner = Path(directory) / 'isolate'
            runner.write_text('#!/bin/sh\nprintf "UPDATE_PROOF:%s\\n" "$BUTLER_NATIVE_AGENT_EXECUTABLE"\n')
            runner.chmod(0o700)
            for skip, builds, code in [('true', '', 0), ('false', '', 1),
                                        ('false', directory, 0)]:
                env = dict(os.environ, MANUAL_WITHOUT_UPDATE_FIXTURES=skip,
                           BUTLER_UPDATE_SMOKE_AGENT_BUILDS=builds, isolate=str(runner))
                result = subprocess.run(['bash', '-eu', '-c', script], env=env,
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual('::warning::Skipped app-update-work-stream smoke:' in result.stdout,
                                 skip == 'true')
                self.assertEqual('UPDATE_PROOF:' in result.stdout, bool(builds))
                if builds:
                    self.assertIn(builds + '/0.1.0-preview.91/butler-agent', result.stdout)
                elif skip == 'false':
                    self.assertIn('update-fixture agents required', result.stderr)


if __name__ == '__main__':
    unittest.main()
