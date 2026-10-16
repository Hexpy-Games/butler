#!/usr/bin/env python3
"""Run a check with disposable home/data directories and stable tool caches."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

base = os.environ.get('RUNNER_TEMP', os.environ.get('TMPDIR', '/tmp'))
with tempfile.TemporaryDirectory(prefix='ci-home-', dir=base) as home, tempfile.TemporaryDirectory(prefix='ci-data-', dir=base) as data:
    # Hooks export repository-local Git state; it must not redirect nested repos
    # or cargo/build-script Git calls into the repository that invoked the hook.
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(HOME=home, BUTLER_DATA=data, TMPDIR=base)
    env.setdefault('CARGO_HOME', str(Path.home() / '.cargo'))
    env.setdefault('RUSTUP_HOME', str(Path.home() / '.rustup'))
    sys.exit(subprocess.call(sys.argv[1:], env=env))
