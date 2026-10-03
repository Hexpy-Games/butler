#!/usr/bin/env python3
"""Run complete idle and owner-scale libtest observations from a release archive."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix='idle-archive-', dir=os.environ.get('RUNNER_TEMP', os.environ.get('TMPDIR'))) as target:
    listing = subprocess.check_output([
        'cargo-nextest', 'nextest', 'list', '--archive-file', sys.argv[1],
        '--extract-to', target, '--workspace-remap', str(Path.cwd()),
        '--message-format', 'json', '-E', 'binary(=e2e) and test(/^(idle_resources|data_perf)::/)',
    ], text=True)
    suites = [suite for suite in json.loads(listing)['rust-suites'].values() if suite['binary-name'] == 'e2e']
    assert len(suites) == 1, suites
    suite = suites[0]
    env = dict(os.environ, NEXTEST_WORKSPACE_ROOT=str(Path.cwd()))
    assert env.get('BUTLER_E2E_TIER') == 'perf' and env.get('BUTLER_E2E_PERF') == '1', 'Complete observations require the perf tier and budgets'
    for prefix, label in [('idle_resources::', 'PERF-IDLE'), ('data_perf::', 'PERF-DATA')]:
        selected = [name for name, test in suite['testcases'].items() if name.startswith(prefix) and not test['ignored']]
        assert selected, f'{label} must not be silently dropped'
        print(f'{label} selection:', ', '.join(selected), flush=True)
        subprocess.run([suite['binary-path'], prefix, '--nocapture', '--test-threads=1'], env=env, cwd=suite['cwd'], check=True)
