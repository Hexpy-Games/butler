#!/usr/bin/env python3
"""Fail closed on failed, cancelled or unexpectedly skipped selected checks."""
import json
import os

jobs = json.loads(os.environ['RESULTS'])
assert jobs['changes']['result'] == 'success', jobs
changes = jobs['changes']['outputs']

integration = changes['tier'] == 'integration'
selected = json.loads(changes['jobs'])
for name, enabled in selected.items():
    expected = 'success' if enabled else 'skipped'
    assert jobs[name]['result'] == expected, f'{name}: {jobs[name]["result"]}, expected {expected}'
print('All selected checks passed.')
