#!/usr/bin/env python3
"""Fail closed on failed, cancelled or unexpectedly skipped selected checks."""
import json
import os

from ci_policy import rust_jobs

jobs = json.loads(os.environ['RESULTS'])
assert jobs['changes']['result'] == 'success', jobs
changes = jobs['changes']['outputs']

integration = changes['tier'] == 'integration'
selected = rust_jobs(changes, os.environ['EVENT'])
if integration:
    selected = json.loads(changes['jobs'])
if 'lint' in jobs and not integration:
    assert jobs['lint']['result'] == 'success', jobs['lint']
for name, enabled in selected.items():
    expected = 'success' if enabled else 'skipped'
    assert jobs[name]['result'] == expected, f'{name}: {jobs[name]["result"]}, expected {expected}'
print('All selected checks passed.')
