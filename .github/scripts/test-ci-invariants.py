#!/usr/bin/env python3
"""Exercise artifact trust and complete compiled shard coverage.

Optional argument: directory containing e2e-list.json, perf-list.json, shards/.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('provenance', ROOT / 'agent-provenance.py')
provenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provenance)
INVENTORY = Path(sys.argv.pop()) if len(sys.argv) > 1 else None


class ArtifactTrust(unittest.TestCase):
    # test-category: security
    def test_exact_identity_and_digest_required(self):
        expected = dict(schema=1, sha='a' * 40, platform='linux-x64', version='0.1.0-preview.99',
                        native_mode='static-ort', profile='release', toolchain='1.91.0',
                        debug_assertions='true', overflow_checks='true', rustflags='mold',
                        lto='', codegen_units='')
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'butler-agent').write_text('#!/bin/sh\necho "butler 0.1.0-preview.99 (fixture)"\n')
            provenance.record(directory, expected)
            self.assertTrue(provenance.verify(directory, expected))
            for key in expected:
                self.assertFalse(provenance.verify(directory, dict(expected, **{key: 'different'})), key)
            (directory / 'butler-agent').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'digest'):
                provenance.verify(directory, expected)
            (directory / 'butler-agent').write_text('#!/bin/sh\necho "butler 0.1.0-dev (fixture)"\n')
            with self.assertRaisesRegex(ValueError, 'embedded version'):
                provenance.record(directory, expected)

    # test-category: security
    def test_failed_incomplete_or_foreign_runs_never_downloaded(self):
        runs = [dict(id=1, status='completed', conclusion='failure', head_repository={'full_name': 'owner/repo'}),
                dict(id=2, status='in_progress', conclusion=None, head_repository={'full_name': 'owner/repo'}),
                dict(id=3, status='completed', conclusion='success', head_repository={'full_name': 'fork/repo'})]
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), \
             patch.object(provenance, 'output', return_value=json.dumps({'workflow_runs': runs})) as api, \
             patch.object(provenance.subprocess, 'run') as download, contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(provenance.reuse(Path('/unused'), {'platform': 'linux-x64', 'sha': 'a' * 40}))
            self.assertEqual(api.call_count, 1)
            download.assert_not_called()


class Gate(unittest.TestCase):
    # test-category: pure-logic
    def test_every_selected_job_must_succeed(self):
        jobs = ['source', 'linux-clippy', 'linux-archive', 'linux-tests', 'macos-archive', 'macos-tests',
                'macos-package', 'linux-arm64-archive', 'linux-arm64-tests', 'linux-package-x64',
                'linux-package-arm64', 'install-x64', 'install-arm64', 'install-macos', 'install-merge', 'ui', 'site', 'ds']
        outputs = dict.fromkeys(['rust', 'package', 'install', 'linux-package', 'ui', 'site', 'ds'], 'true')
        results = {job: {'result': 'success'} for job in jobs}
        results['linux-arm64-tests']['result'] = 'skipped'  # Existing non-PR arm64 restriction.
        results['changes'] = dict(result='success', outputs=outputs)
        env = dict(os.environ, EVENT='pull_request', RESULTS=json.dumps(results))
        self.assertEqual(subprocess.run([sys.executable, ROOT / 'check-gate.py'], env=env, capture_output=True).returncode, 0)
        for job in jobs:
            if job == 'linux-arm64-tests':
                continue
            for outcome in ['failure', 'cancelled', 'skipped']:
                changed = json.loads(json.dumps(results))
                changed[job]['result'] = outcome
                env['RESULTS'] = json.dumps(changed)
                self.assertNotEqual(subprocess.run([sys.executable, ROOT / 'check-gate.py'], env=env, capture_output=True).returncode, 0, (job, outcome))


class Coverage(unittest.TestCase):
    # test-category: pure-logic
    def test_compiled_ordinary_install_and_perf_are_complete(self):
        if INVENTORY is None:
            self.fail('Supply the compiled inventory directory; coverage must be proven')
        listing = 'e2e-list.json' if (INVENTORY / 'e2e-list.json').exists() else 'list.json'
        directory = INVENTORY / 'shards' if (INVENTORY / 'shards').exists() else INVENTORY
        inventory = json.loads((INVENTORY / listing).read_text())
        tests = {name: test for suite in inventory['rust-suites'].values()
                 if suite['binary-name'] == 'e2e' for name, test in suite['testcases'].items()}
        selections = json.loads((directory / 'selection.json').read_text())
        ordinary = [name for shard in selections for binary, name in shard]
        expected = {name for name in tests if not any(part.startswith(('ins_', 'perf_')) for part in name.split('::'))
                    and not name.endswith('idle_disk_writes_and_cpu_stay_bounded')}
        self.assertEqual(len(ordinary), len(set(ordinary)))
        self.assertEqual(set(ordinary), expected)
        installs = {name for name in tests if any(part.startswith('ins_') for part in name.split('::'))}
        groups = [{name for name in installs if '::ins_02_' in name},
                  {name for name in installs if '::ins_14_' in name},
                  {name for name in installs if '::ins_02_' not in name and '::ins_14_' not in name}]
        self.assertEqual(sum(map(len, groups)), len(installs))
        perf_inventory = json.loads((INVENTORY / 'perf-list.json').read_text())
        perf = {name for suite in perf_inventory['rust-suites'].values() for name, test in suite['testcases'].items()
                if test['filter-match']['status'] == 'matches'}
        perf_selections = json.loads((directory / 'perf-selection.json').read_text())
        selected = [name for shard in perf_selections for binary, name in shard]
        idle = {name for name in perf if name.startswith('idle_resources::')}
        self.assertEqual(len(selected), len(set(selected)))
        self.assertEqual(set(selected) | idle, perf)
        self.assertTrue(idle, 'The complete idle observation must remain selected')
        runnable = {name for name, test in tests.items() if not test['ignored']}
        disk = {name for name in tests if name.endswith('idle_disk_writes_and_cpu_stay_bounded')}
        self.assertEqual((set(ordinary) | installs | perf | disk) & runnable, runnable)
        print(f'Compiled inventory: {len(tests)} tests, {len(tests) - len(runnable)} existing ignored; '
              f'ordinary {list(map(len, selections))}, install {list(map(len, groups))}, '
              f'perf {list(map(len, perf_selections))} + {len(idle)} full idle observation(s).')


if __name__ == '__main__':
    unittest.main()
