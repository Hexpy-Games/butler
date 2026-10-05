#!/usr/bin/env python3
"""Preserve the complete fingerprinted native-deps cache outside cache eviction."""
import os
from pathlib import Path
import runpy
import sys

cache = runpy.run_path(str(Path(__file__).with_name('cargo-artifact-cache.py')))
command, platform, fingerprint = sys.argv[1:]
expected = dict(schema=1, platform=platform, kind='ort', fingerprint=fingerprint)
base = Path(os.environ['RUNNER_TEMP']) / 'ort-cache'
base.mkdir(parents=True, exist_ok=True)
os.chdir(base)
if command == 'restore':
    cache['restore'](expected, root='native-deps')
elif command == 'record':
    cache['record'](Path(os.environ['RUNNER_TEMP']) / 'static-runtime-artifact', expected, root='native-deps')
else:
    raise SystemExit(f'Unknown command: {command}')
