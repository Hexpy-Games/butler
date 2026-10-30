#!/usr/bin/env python3
"""Block unrelated main PRs while a main-push workflow is red."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from ci_main_baseline import latest_main_run
from issue_links import references

POLL_SECONDS = 60
# Stay below the gate job's timeout-minutes (90) so the step fails closed itself.
WAIT_SECONDS = 80 * 60
API_ERRORS = (subprocess.CalledProcessError, OSError, ValueError, KeyError, TypeError)


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
    same_repo = (pr['head'].get('repo', {}).get('full_name') == repository
                 and pr['base'].get('repo', {}).get('full_name') == repository)
    if same_repo and re.fullmatch(r'fix/revert-pr-.*', pr['head']['ref']):
        return True
    if any(label['name'] == 'ci:main-fix' for label in pr.get('labels', [])):
        return True
    return False


def failure_issues(repository, run):
    """Open reporter issues carrying current evidence for this failing workflow run."""
    try:
        issues = api(f'repos/{repository}/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100')
        return [issue['number'] for issue in issues
                if not issue.get('pull_request')
                and issue.get('user', {}).get('login') == 'github-actions[bot]'
                and current_failure(issue.get('body') or '', run)]
    except (subprocess.CalledProcessError, OSError, ValueError, KeyError, TypeError):
        return []


def declares_fix(pr, repository, issues):
    # A fix/ branch or a git-revert title must close the current failure issue.
    if not (pr['head']['ref'].startswith('fix/') or (pr.get('title') or '').startswith('Revert')):
        return False
    closed, _, _ = references(repository, pr.get('body') or '')
    return bool(closed & set(issues))


def current_failure(body, run):
    workflow = re.escape(str(run['workflow_id']))
    section = re.search(r'<!-- workflow:' + workflow + r' -->(.*?)<!-- /workflow:'
                        + workflow + r' -->', body, re.S)
    if not section:
        return False
    sha = re.escape(run['head_sha'])
    return bool(re.search(r'<!-- main-ci-range:[^\s:]+:' + sha + r' -->', body)
                or re.search(r'Workflow green baseline: `[^`]+` → `' + sha + r'`', section[1]))


def main_gate(event, repository, event_name):
    pr = event.get('pull_request', {})
    if event_name != 'pull_request' or pr.get('base', {}).get('ref') != 'main':
        return 0
    if bypass(pr, repository):
        return 0
    for workflow in main_workflows():
        try:
            run = latest_main_run(workflow, repository, command, conclusions=None)
        except (subprocess.CalledProcessError, OSError, ValueError, KeyError, TypeError):
            print('::warning::Main CI API unavailable; merge block skipped.')
            return 0
        if not run or run['conclusion'] != 'failure':
            continue
        issues = failure_issues(repository, run)
        if not declares_fix(pr, repository, issues):
            target = ' or '.join(f'#{n}' for n in issues) or 'the main-failure issue'
            print(f'Main is failing ({run["html_url"]}), so only fixes for {target} or `ci:main-fix` PRs can merge.')
            return 1
    return 0


def latest_full_run(pr, repository):
    runs = api(f'repos/{repository}/actions/workflows/rust-quality.yml/runs?event=pull_request'
               f'&head_sha={pr["head"]["sha"]}&per_page=100')['workflow_runs']
    for run in sorted(runs, key=lambda run: run['id'], reverse=True):
        if (run['head_sha'] == pr['head']['sha']
                and run.get('display_title') == f'CI #{run["id"]}'
                and any(p['number'] == pr['number'] for p in run.get('pull_requests', []))):
            return run
    return None


def full_run_passed(run, repository):
    jobs = api(f'repos/{repository}/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100')
    if jobs['total_count'] != len(jobs['jobs']):
        return False
    return any(job['name'] == 'gate' and any(
        step['name'] == 'Require every selected check' and step['conclusion'] == 'success'
        for step in job.get('steps', [])) for job in jobs['jobs'])


def poll(call, sleep, clock, deadline):
    """Retry a transient GitHub API error until the deadline, then re-raise it."""
    while True:
        try:
            return call()
        except API_ERRORS as error:
            print(f'::warning::GitHub API error while polling the full CI run: {error!r}', flush=True)
            if clock() >= deadline:
                raise
            sleep(POLL_SECONDS)


def quality_gate(event, repository, sleep=time.sleep, clock=time.monotonic, wait_seconds=WAIT_SECONDS):
    """A metadata-only gate must never replace failed/pending quality with green.

    A full run still in progress is awaited, so this gate finishes after the
    full run's own gate and reports its result instead of a stale failure.
    A transient API error is retried until the deadline; the deadline, a run
    still unfinished at that point, or a persistent error all fail the gate.
    """
    pr = event['pull_request']
    deadline = clock() + wait_seconds
    try:
        run = poll(lambda: latest_full_run(pr, repository), sleep, clock, deadline)
        while run and run['status'] != 'completed':
            if clock() >= deadline:
                print('Timed out waiting for the full CI run to finish.')
                return 1
            print(f'Waiting for the full CI run to finish: {run["html_url"]}', flush=True)
            sleep(POLL_SECONDS)
            run = poll(lambda: latest_full_run(pr, repository), sleep, clock, deadline)
        if run and poll(lambda: full_run_passed(run, repository), sleep, clock, deadline):
            return 0
    except API_ERRORS:
        print('GitHub API stayed unavailable; quality cannot be confirmed for this SHA.')
        return 1
    print('Quality checks have not passed for this SHA; complete a full CI run.')
    return 1


if __name__ == '__main__':
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    repository = os.environ['GITHUB_REPOSITORY']
    if sys.argv[1:] == ['quality']:
        sys.exit(quality_gate(event, repository))
    sys.exit(main_gate(event, repository, os.environ['GITHUB_EVENT_NAME']))
