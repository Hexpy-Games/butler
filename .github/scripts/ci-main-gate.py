#!/usr/bin/env python3
"""Block unrelated main PRs while a main-push workflow is red."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from ci_main_baseline import latest_main_run


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE)


def api(path):
    return json.loads(command('gh', 'api', path))


def main_workflows():
    # Read the push block, not workflow_run/workflow_call or job-level branches.
    for path in sorted((Path(__file__).parent.parent / 'workflows').glob('*.yml')):
        push = re.search(r'^  push:\n((?:^    .*\n|^\s*#.*\n|^\n)*)', path.read_text(), re.M)
        if push and re.search(r'^    branches: \[[^\n]*\bmain\b', push[1], re.M):
            yield path.name


def bypass(pr, repository):
    if re.fullmatch(r'fix/revert-pr-.*', pr['head']['ref']):
        return True
    if any(label['name'] == 'ci:main-fix' for label in pr.get('labels', [])):
        return True
    # Only same-repository issue links; titles alone never grant a bypass.
    numbers = re.findall(r'https://github\.com/' + re.escape(repository)
                         + r'/issues/(\d+)\b', pr.get('body') or '')
    numbers += re.findall(r'(?<![\w/])#(\d+)\b', pr.get('body') or '')
    for number in dict.fromkeys(numbers):
        issue = api(f'repos/{repository}/issues/{number}')
        if (issue.get('state') == 'open' and not issue.get('pull_request')
                and issue.get('user', {}).get('login') == 'github-actions[bot]'
                and re.search(r'<!-- main-ci-range:[^\s:]+:[^\s:]+ -->', issue.get('body') or '')):
            return True
    return False


def main_gate(event, repository, event_name):
    pr = event.get('pull_request', {})
    if event_name != 'pull_request' or pr.get('base', {}).get('ref') != 'main':
        return 0
    try:
        if bypass(pr, repository):
            return 0
        for workflow in main_workflows():
            run = latest_main_run(workflow, repository, command, conclusions=None)
            if run and run['conclusion'] == 'failure':
                print(f'Main CI failed: {run["html_url"]}; use fix/revert-pr-*, ci:main-fix, or link an open main-failure issue.')
                return 1
    except (subprocess.CalledProcessError, OSError, ValueError, KeyError, TypeError):
        print('::warning::Main CI API unavailable; merge block skipped.')
    return 0


def quality_gate(event, repository):
    """A metadata-only gate must never replace failed/pending quality with green."""
    pr = event['pull_request']
    runs = api(f'repos/{repository}/actions/workflows/rust-quality.yml/runs?event=pull_request&per_page=100')['workflow_runs']
    runs = sorted(runs, key=lambda run: run['id'], reverse=True)
    for run in runs:
        if (run['head_sha'] != pr['head']['sha']
                or run.get('display_title') != f'CI #{run["id"]}'
                or not any(p['number'] == pr['number'] for p in run.get('pull_requests', []))):
            continue
        if run['status'] != 'completed':
            break
        jobs = api(f'repos/{repository}/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100')
        if jobs['total_count'] != len(jobs['jobs']):
            break
        for job in jobs['jobs']:
            if job['name'] == 'gate' and any(
                    step['name'] == 'Require every selected check' and step['conclusion'] == 'success'
                    for step in job.get('steps', [])):
                return 0
        break
    print('Quality checks have not passed for this SHA; complete a full CI run.')
    return 1


if __name__ == '__main__':
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    repository = os.environ['GITHUB_REPOSITORY']
    if sys.argv[1:] == ['quality']:
        sys.exit(quality_gate(event, repository))
    sys.exit(main_gate(event, repository, os.environ['GITHUB_EVENT_NAME']))
