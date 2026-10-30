#!/usr/bin/env python3
"""Derive PR smoke coverage and failure semantics from the real workflow steps."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import unittest
from types import SimpleNamespace

import ci_policy

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / '.github/workflows'


def step(source, name):
    block = source.split('      - name: ' + name + '\n', 1)[1]
    return re.split(r'\n      - (?:name:|uses:|if:)', block, maxsplit=1)[0]


def expression(value, **context):
    # Evaluate the workflow's boolean/string expressions over fixture contexts.
    context.setdefault('event', SimpleNamespace(action=''))
    value = value.removeprefix('${{').removesuffix('}}').strip()
    return eval(value.replace('&&', ' and ').replace('||', ' or '),
                {'__builtins__': {}, 'github': SimpleNamespace(**context),
                 'always': lambda: True, 'fromJSON': json.loads,
                 'contains': lambda values, value: value in values, 'startsWith': lambda text, prefix: text.startswith(prefix),
                 'format': lambda template, *args: template.format(*args)})


class PrWorkspace(unittest.TestCase):
    # test-category: pure-logic
    def test_pr_filter_and_failure_options_equal_smoke_workspace(self):
        archive = (WORKFLOWS / 'rust-archive.yml').read_text()
        tests = (WORKFLOWS / 'rust-tests.yml').read_text()
        pr = step(archive, 'Run PR workspace smoke in the build VM')
        workspace = step(tests, 'List and run workspace tests without rebuilding')
        filters = [re.search(r"-E '([^']+)'", text)[1] for text in (pr, workspace)]
        self.assertEqual(filters[0], filters[1])
        self.assertEqual(filters[0], 'not package(=butler-e2e)')
        for text in (pr, workspace):
            command = next(line for line in text.splitlines() if ' run "${args[@]}"' in line)
            tokens = shlex.split(command.strip())
            self.assertEqual(tokens[tokens.index('run') + 2:], ['--no-fail-fast', '--retries', '0'])
            self.assertIn('--config-file "$GITHUB_WORKSPACE/.config/nextest.toml"', command)
            self.assertIn(' nextest list "${args[@]}"', text)
            self.assertIn('isolated.py', text)
        build = step(archive, 'Build the complete workspace once')
        for flag in ['--workspace', '--all-targets', '--locked']:
            self.assertIn(flag, build)
            self.assertIn(flag, pr)
        self.assertIn('butler-agent/static-ort', pr)

    # test-category: security
    def test_pr_archive_owns_gate_and_main_keeps_separate_workspace(self):
        flags = dict.fromkeys(['rust', 'package', 'install', 'linux-package', 'ui', 'site', 'ds', 'workflows'], 'true')
        flags['tier'] = 'smoke'
        for event in ['pull_request', 'push', 'workflow_dispatch']:
            selected = ci_policy.rust_jobs(flags, event)
            self.assertTrue(selected['linux-archive'])
            self.assertEqual(selected['linux-tests'], event != 'pull_request')
            for result in ['success', 'failure', 'cancelled', 'skipped']:
                outputs = dict(tier='smoke', jobs=json.dumps({
                    'linux-archive': True, 'linux-tests': selected['linux-tests']}))
                jobs = dict(changes=dict(result='success', outputs=outputs),
                            **{'linux-archive': dict(result=result), 'linux-tests': dict(
                                result='success' if selected['linux-tests'] else 'skipped')})
                actual = subprocess.run(['python3', ROOT / '.github/scripts/check-gate.py'],
                                        env=dict(os.environ, RESULTS=json.dumps(jobs)), capture_output=True)
                self.assertEqual(actual.returncode == 0, result == 'success', actual.stderr)

    # test-category: pure-logic
    def test_legacy_contexts_follow_release_ruleset_only(self):
        quality = (WORKFLOWS / 'rust-quality.yml').read_text()
        legacy = quality.split('\n  legacy-gates:\n')[1]
        condition = re.search(r'^    if: (.+)$', legacy, re.M)[1]
        for event in ['pull_request', 'push', 'workflow_dispatch']:
            for base in ['main', 'release/1.2.3', 'release/1.2.3-preview.13']:
                for ref in ['refs/heads/main', 'refs/heads/release/1.2.3', 'refs/pull/12/merge']:
                    expected = ((event == 'pull_request' and base.startswith('release/')) or
                                (event == 'push' and ref.startswith('refs/heads/release/')))
                    self.assertEqual(expression(condition, event_name=event, base_ref=base, ref=ref),
                                     expected, (event, base, ref))
        self.assertIn('needs: gate', legacy)
        self.assertIn('run: test "$RESULT" = success', legacy)

    # test-category: pure-logic
    def test_release_dispatch_and_push_share_integration_concurrency(self):
        quality = (WORKFLOWS / 'rust-quality.yml').read_text()
        group = re.search(r'^  group: (.+)$', quality, re.M)[1]
        for event in ['push', 'workflow_dispatch']:
            for ref in ['refs/heads/release/1.2.3', 'refs/heads/release/1.2.3-preview.13']:
                self.assertEqual(expression(group, event_name=event, ref=ref, run_id=123),
                                 'integration-' + ref)
        for run in [123, 456]:
            self.assertEqual(expression(group, event_name='workflow_dispatch',
                                        ref='refs/heads/main', run_id=run),
                             'rust-quality-dispatch-' + str(run))
        self.assertEqual(expression(group, event_name='pull_request', ref='refs/pull/12/merge',
                                    head_ref='fix/example', ref_name='12/merge'),
                         'rust-quality-fix/example')
        for action in ('labeled', 'unlabeled', 'edited'):
            self.assertEqual(expression(group, event_name='pull_request', ref='refs/pull/12/merge',
                                        head_ref='fix/example', ref_name='12/merge',
                                        event=SimpleNamespace(action=action)),
                             'rust-quality-metadata-fix/example')

    # test-category: format-pin
    def test_only_pr_x64_call_uses_in_place_execution_and_dispatch_is_independent(self):
        quality = (WORKFLOWS / 'rust-quality.yml').read_text()
        linux = quality.split('\n  linux-archive:\n')[1].split('\n  linux-perf-archive:')[0]
        self.assertIn("smoke-in-place: ${{ github.event_name == 'pull_request' }}", linux)
        self.assertEqual(quality.count('      smoke-in-place:'), 1)
        archive = (WORKFLOWS / 'rust-archive.yml').read_text()
        self.assertIn("SMOKE_IN_PLACE: ${{ inputs.smoke-in-place && github.event_name == 'pull_request' }}", archive)
        self.assertEqual(archive.count("if: ${{ !(inputs.smoke-in-place && github.event_name == 'pull_request') }}"), 2)
        self.assertIn("format('rust-quality-dispatch-{0}', github.run_id)", quality)
        self.assertIn("name: ${{ github.event_name == 'workflow_dispatch' && 'dispatch gate' || 'gate' }}", quality)
        spec = importlib.util.spec_from_file_location('changes', ROOT / '.github/scripts/ci-changes.py')
        changes = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(changes)
        self.assertIn('rust', changes.job_groups('rust-quality.yml')['linux-archive'])


if __name__ == '__main__':
    unittest.main()
