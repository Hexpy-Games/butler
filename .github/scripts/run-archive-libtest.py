#!/usr/bin/env python3
"""Reuse an archived harness with the original cargo-test/libtest selections."""
import json
import os
from pathlib import Path
import subprocess
import sys


def prepare(archive, directory):
    listing = subprocess.check_output([
        'cargo-nextest', 'nextest', 'list', '--archive-file', archive,
        '--extract-to', str(directory), '--workspace-remap', str(Path.cwd()),
        '--message-format', 'json', '-E', 'package(=butler-e2e) and binary(=e2e)',
    ], text=True)
    suites = [suite for suite in json.loads(listing)['rust-suites'].values()
              if suite['binary-name'] == 'e2e']
    if len(suites) != 1:
        raise ValueError('Archive must contain exactly one E2E harness')
    (directory / 'libtest-suite.json').write_text(json.dumps(suites[0]))


def run(directory, selection):
    suite = json.loads((directory / 'libtest-suite.json').read_text())
    selected = [name for name, test in suite['testcases'].items()
                if selection in name and not test['ignored']]
    if not selected:
        raise ValueError('Original libtest selection must not be empty')
    print(f'Original libtest selection ({len(selected)}): ' + ', '.join(selected), flush=True)
    env = dict(os.environ, NEXTEST_WORKSPACE_ROOT=str(Path.cwd()))
    # No nextest deadline is imposed on the original ten-minute observation.
    return subprocess.call([suite['binary-path'], selection, '--nocapture'],
                           cwd=suite['cwd'], env=env)


if __name__ == '__main__':
    command, directory, argument = sys.argv[1:]
    directory = Path(directory)
    if command == 'prepare':
        prepare(argument, directory)
    elif command == 'run':
        sys.exit(run(directory, argument))
    else:
        raise SystemExit('Usage: run-archive-libtest.py prepare|run DIRECTORY ARCHIVE|FILTER')
