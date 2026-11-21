#!/usr/bin/env python3
"""Run a check with disposable home/data directories and stable tool caches."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

base = os.environ.get('RUNNER_TEMP') or tempfile.gettempdir()
with tempfile.TemporaryDirectory(prefix='ci-home-', dir=base) as home, tempfile.TemporaryDirectory(prefix='ci-data-', dir=base) as data:
    # Hooks export repository-local Git state; it must not redirect nested repos
    # or cargo/build-script Git calls into the repository that invoked the hook.
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    # Windows reads the home from USERPROFILE; repository text is UTF-8 on every host.
    env.update(HOME=home, USERPROFILE=home, BUTLER_DATA=data, TMPDIR=base, PYTHONUTF8='1')
    env.setdefault('CARGO_HOME', str(Path.home() / '.cargo'))
    env.setdefault('RUSTUP_HOME', str(Path.home() / '.rustup'))
    # rustup proxies in CARGO_HOME/bin keep the named toolchain usable in non-login hooks.
    cargo_bin = Path(env['CARGO_HOME']) / 'bin'
    if cargo_bin.is_dir() and str(cargo_bin) not in env.get('PATH', '').split(os.pathsep):
        env['PATH'] = os.pathsep.join([str(cargo_bin), env.get('PATH', '')])
    sys.exit(subprocess.call(sys.argv[1:], env=env))
