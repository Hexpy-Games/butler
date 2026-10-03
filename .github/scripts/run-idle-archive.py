#!/usr/bin/env python3
"""Run the complete PERF-IDLE libtest binary from a release nextest archive."""
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
        '--message-format', 'json', '-E', 'binary(=e2e) and test(/^idle_resources::/)',
    ], text=True)
    suites = [suite for suite in json.loads(listing)['rust-suites'].values() if suite['binary-name'] == 'e2e']
    assert len(suites) == 1, suites
    suite = suites[0]
    assert any(name.startswith('idle_resources::') for name in suite['testcases']), 'PERF-IDLE must not be silently dropped'
    print('PERF-IDLE selection:', ', '.join(name for name in suite['testcases'] if name.startswith('idle_resources::')), flush=True)
    env = dict(os.environ, NEXTEST_WORKSPACE_ROOT=str(Path.cwd()))
    subprocess.run([suite['binary-path'], 'idle_resources::', '--nocapture', '--test-threads=1'], env=env, cwd=suite['cwd'], check=True)
