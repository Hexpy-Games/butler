#!/usr/bin/env python3
"""Require successful selected jobs, and only intentional skipped jobs."""
import json
import os

jobs = json.loads(os.environ['RESULTS'])
assert jobs['changes']['result'] == 'success', jobs
outputs = jobs['changes']['outputs']
for name, groups in json.loads(os.environ['CHECK_GROUPS']).items():
    enabled = json.loads(outputs['jobs'])[name] if outputs.get('tier') == 'integration' else any(outputs[group] == 'true' for group in groups)
    expected = 'success' if enabled else 'skipped'
    assert jobs[name]['result'] == expected, f'{name}: {jobs[name]["result"]}, expected {expected}'
print('All selected checks passed.')
