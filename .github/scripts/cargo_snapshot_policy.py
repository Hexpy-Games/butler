"""Snapshot publication freshness and concise GitHub Actions evidence."""
from datetime import datetime, timezone
import os
from pathlib import Path
import time

import runner_cache


def age_hours(timestamp):
    return (datetime.now(timezone.utc) - datetime.fromisoformat(timestamp.replace('Z', '+00:00'))).total_seconds() / 3600


def stale(metadata, api):
    repository = os.environ['GITHUB_REPOSITORY']
    run = api(f'repos/{repository}/actions/runs/{int(metadata["run_id"])}')
    if age_hours(run['created_at']) >= 12:
        return True
    sha = os.environ['GITHUB_SHA']
    if sha == metadata['sha']:
        return False
    comparison = api(f'repos/{repository}/compare/{metadata["sha"]}...{sha}')
    return comparison['status'] not in ('ahead', 'identical') or comparison['ahead_by'] >= 20


def report(operation, expected, key, generation, match, compressed, started, outcome):
    lane = '/'.join(str(expected.get(field, '?')) for field in ('platform', 'mode', 'kind', 'profile'))
    line = (f'Cargo {operation}: lane={lane}; key={key}; generation={generation}; {match}; '
            f'compressed bytes={compressed}; minutes={(time.monotonic() - started) / 60:.2f}; {outcome}')
    print(line)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(runner_cache.extended(os.environ['GITHUB_STEP_SUMMARY']), 'a') as summary:
            summary.write(line + '\n')


def compressed_bytes(directory):
    directory = Path(runner_cache.extended(directory))
    return sum(path.stat().st_size for path in directory.glob('*.zst'))
