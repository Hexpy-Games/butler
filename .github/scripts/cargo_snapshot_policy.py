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


def retired_versions(versions, active_tag):
    """Retire whole compatibility keys only when their newest generation is 14 days old."""
    import re
    keys = {}
    for entry in versions:
        for tag in entry['metadata']['container']['tags']:
            match = re.fullmatch(r'(compatible-.+)--\d+-\d+', tag)
            if match:
                keys.setdefault(match[1], []).append(entry)
    retired = set()
    for key, entries in keys.items():
        timestamps = [entry.get('created_at') for entry in entries]
        if key != active_tag and all(timestamps) and min(map(age_hours, timestamps)) >= 14 * 24:
            retired.add(key)
    return [entry for entry in versions
            if (tags := entry['metadata']['container']['tags'])
            and (owners := {tag.split('--', 1)[0] for tag in tags if '--' in tag})
            and owners <= retired]
