#!/usr/bin/env python3
"""Summarize gh run view metadata and Actions API step timestamps, in seconds.

Usage: ci-timings.py DIRECTORY. Each RUN.json is gh run view --json jobs,...;
RUN.api.json contains the API jobs array (step timestamps are absent from gh).
Only completed jobs are timed. Failed/cancelled observations remain labelled.
"""
from collections import defaultdict
from datetime import datetime
import json
from pathlib import Path
from statistics import median
import sys


def seconds(start, end):
    if not start or not end or start.startswith('0001') or end.startswith('0001'):
        return 0
    return max(0, (datetime.fromisoformat(end.replace('Z', '+00:00')) -
                   datetime.fromisoformat(start.replace('Z', '+00:00'))).total_seconds())


def category(name):
    name = name.lower()
    if name.startswith('post ') or 'complete job' in name:
        return 'other'
    if 'publish decisions' in name:
        return 'test'
    if any(word in name for word in ['upload', 'publish', 'keep the', 'attach']):
        return 'upload'
    if any(word in name for word in ['set up', 'setup', 'restore', 'cache', 'download', 'checkout', 'check out', 'install pinned', 'install app', 'install dependenc', 'install package tools']):
        return 'setup'
    # Composite actions include nested build/test/cache work in one timed step.
    if name.startswith('run ./.github/actions/') or 'build, package and smoke' in name:
        return 'mixed'
    if any(word in name for word in ['build', 'compile', 'prepare the native agent', 'package the native app', 'package the app', 'package and smoke the native app']):
        return 'build'
    if any(word in name for word in ['test', 'suite', 'smoke', 'clippy', 'gate', 'check', 'prove', 'verify', 'lint', 'contract', 'stub', 'e2e', 'budget', 'install, run', 'regression', 'recovery', 'through settings', 'command tool', 'pairing', 'xml', 'layout']):
        return 'test'
    return 'other'


def rows(directory):
    selected = {str(run['databaseId']) for path in directory.glob('*.runs.json')
                for run in json.loads(path.read_text())}
    for path in sorted(directory.glob('*.json')):
        if path.stem not in selected:
            continue
        run = json.loads(path.read_text())
        api = json.loads(path.with_suffix('.api.json').read_text())
        for job in api:
            if job['conclusion'] == 'skipped' or job['status'] != 'completed' or not job['runner_id']:
                continue
            totals = dict.fromkeys(['setup', 'build', 'test', 'upload', 'mixed', 'other'], 0)
            for step in job['steps']:
                totals[category(step['name'])] += seconds(step['started_at'], step['completed_at'])
            wall = seconds(job['started_at'], job['completed_at'])
            totals['other'] += max(0, wall - sum(totals.values()))
            yield dict(run=path.stem, workflow=run['workflowName'], job=job['name'],
                       result=job['conclusion'], queue=seconds(job['created_at'], job['started_at']),
                       wall=wall, **totals)


def report(directory):
    observations = list(rows(directory))
    print('Queue = job started_at − created_at (excludes dependency wait).')
    print('Composite steps cannot be decomposed using job metadata; shown as mixed.')
    print('Cancelled/failed timings are not successful workflow speed measurements.\n')
    print('| Workflow / job | n (success/failure/cancelled) | Queue | Setup/cache | Build/package | Tests/checks | Upload/publish | Mixed | Other | Wall |')
    print('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    grouped = defaultdict(list)
    for row in observations:
        grouped[(row['workflow'], row['job'])].append(row)
    for (workflow, job), group in sorted(grouped.items()):
        counts = '/'.join(str(sum(r['result'] == result for r in group)) for result in ['success', 'failure', 'cancelled'])
        values = ' | '.join(f'{median(r[key] for r in group):.0f}' for key in ['queue', 'setup', 'build', 'test', 'upload', 'mixed', 'other', 'wall'])
        print(f'| {workflow} / {job} | {len(group)} ({counts}) | {values} |')
    print('\nIndividual observations (all seconds):\n')
    print('| Run | Job | Result | Queue | Setup | Build | Test | Upload | Mixed | Other | Wall |')
    print('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for row in observations:
        values = ' | '.join(f'{row[key]:.0f}' for key in ['queue', 'setup', 'build', 'test', 'upload', 'mixed', 'other', 'wall'])
        print(f'| [{row["run"]}](https://github.com/Hexpy-Games/butler/actions/runs/{row["run"]}) | {row["job"]} | {row["result"]} | {values} |')


if __name__ == '__main__':
    report(Path(sys.argv[1]))
