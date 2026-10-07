#!/usr/bin/env python3
"""Require complete release-branch integration evidence before tag builds."""
import importlib.util
import json
import os
from pathlib import Path
import re
from urllib.parse import urlencode

SPEC = importlib.util.spec_from_file_location('changes', Path(__file__).with_name('ci-changes.py'))
changes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changes)
GATES = {
    'rust-quality.yml': 'gate', 'post-merge-ci.yml': 'post-merge-ci gate',
    'windows-preview-smoke.yml': 'Complete Windows preview verification',
    'windows-installer.yml': 'windows-installer gate',
    'macos-signing.yml': 'macos-signing gate', 'licenses.yml': 'licenses gate',
    'e2e.yml': 'E2E live tier',
}


def api(path):
    return json.loads(changes.command('gh', 'api', path))


def pages(path, key=None):
    responses = json.loads(changes.command('gh', 'api', '--paginate', '--slurp', path))
    return [item for page in responses for item in (page[key] if key else page)]


def trusted(run, repository, branch, workflow):
    return (run.get('status') == 'completed' and run.get('event') in ('push', 'workflow_dispatch')
            and run.get('head_branch') == branch and run.get('path') == f'.github/workflows/{workflow}'
            and run.get('head_repository', {}).get('full_name') == repository)


def prove(workflow, sha, inputs, runs, receipts, gate_ok):
    latest = next((run for run in runs if run['head_sha'] == sha), None)
    if latest and latest['conclusion'] == 'success' and gate_ok(latest):
        return ['direct']
    # Receipts are fetched only through ci-changes.previous(), which verifies
    # repository, branch, workflow, attempt and successful gate publication.
    # Each job uses its newest matching observation: a failure cannot fall back
    # to an older success with identical inputs.
    pending, proof = set(inputs), []
    for receipt in receipts:
        for name in list(pending):
            if receipt.get('job_inputs', {}).get(name) != inputs[name]:
                continue
            if receipt.get('job_hashes', {}).get(name) != inputs[name]:
                proof.append(name)
            pending.remove(name)
    return sorted(pending) + proof


def failed_parts(workflow, job, inputs, receipts):
    parts = changes.ci_parts.inventory(workflow).get(job, [])
    if not parts or not any(receipt.get('part_results') for receipt in receipts):
        return [job]
    missing = []
    for part in parts:
        key = f'{job}/{part}'
        observations = [receipt for receipt in receipts if receipt.get('job_inputs', {}).get(job) == inputs[job]
                        and key in receipt.get('part_results', {})]
        if not observations or observations[0].get('part_hashes', {}).get(key) != inputs[job]:
            missing.append(key)
    return missing or [job]


def waiver(comment, candidate, sha, workflow, job, repository, issue_open, permission, owner, coordinators=()):
    try:
        entry = json.loads(comment['body'])
    except (ValueError, KeyError):
        return False
    if (entry.get('kind') != 'integration-waiver' or entry.get('candidate') != candidate
            or entry.get('sha') != sha or entry.get('workflow') != workflow or entry.get('job') != job
            or not entry.get('reason') or not isinstance(entry.get('issue'), int)):
        return False
    author = comment['user']['login']
    # Coordinators are repository writers. Stable waivers require the exact
    # owner login in the release environment variable BUTLER_RELEASE_OWNER.
    authorized = (author in set(coordinators) | {owner} and permission(author) in ('write', 'maintain', 'admin')) if '-preview.' in candidate else author == owner
    return authorized and issue_open(entry['issue'])


def waived(repository, candidate, sha, workflow, job):
    # Read comments on linked open issues, rather than trusting arbitrary files
    # supplied by a PR. The comment itself records the coordinator/owner actor.
    issues = pages(f'repos/{repository}/issues?state=open&per_page=100')
    permission = lambda login: api(f'repos/{repository}/collaborators/{login}/permission')['permission']
    issue_open = lambda number: api(f'repos/{repository}/issues/{number}').get('state') == 'open'
    for issue in issues:
        if 'pull_request' in issue:
            continue
        comments = pages(issue['comments_url'] + '?per_page=100')
        for comment in comments:
            if waiver(comment, candidate, sha, workflow, job, repository, issue_open,
                      permission, os.environ.get('BUTLER_RELEASE_OWNER', ''),
                      [login.strip() for login in os.environ.get('BUTLER_RELEASE_COORDINATORS', '').split(',')]):
                print(f'WAIVED {workflow}/{job}: {comment["html_url"]}; notify owner after preview')
                return True
    return False


def check(repository, candidate, sha):
    branch = f'release/{candidate}'
    current = changes.hashes('tag')
    missing = []
    for workflow, gate in GATES.items():
        query = urlencode(dict(branch=branch, per_page=100))
        runs = [run for run in pages(f'repos/{repository}/actions/workflows/{workflow}/runs?{query}', 'workflow_runs')
                if trusted(run, repository, branch, workflow)]
        def gate_ok(run):
            jobs = pages(f'repos/{repository}/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100', 'jobs')
            return any(job['name'] == gate and job['conclusion'] == 'success' for job in jobs)
        inputs = changes.integration_inputs(workflow, current, candidate)
        if workflow == 'e2e.yml':
            # Live E2E runs once per release push and must pass at this SHA.
            inputs = {'e2e-live': sha}
            receipts = []
        else:
            receipts = list(changes.previous(repository, None, workflow, branch))
        failures = prove(workflow, sha, inputs, runs, receipts, gate_ok)
        if failures != ['direct']:
            failures = [part for job in failures for part in failed_parts(workflow, job, inputs, receipts)]
        if failures == ['direct']:
            print(f'{workflow}: green at {sha}')
            continue
        if not failures:
            # Gate-level validation (including complete Windows evidence) must
            # also succeed on the target SHA or identical receipted inputs;
            # individual job results cannot prove aggregate completion.
            if not any(gate_ok(run) for run in runs if run['head_sha'] == sha or any(receipt['run'] == run['id'] and receipt.get('job_inputs') == inputs for receipt in receipts)):
                failures = ['gate']
            else:
                print(f'{workflow}: green through matching input receipts')
        for job in failures:
            # Missing/cancelled evidence cannot be waived as a known failure.
            failed = any(receipt.get('checkout') == sha and (receipt.get('job_results', {}).get(job) == 'failure' or receipt.get('part_results', {}).get(job) == 'failure') for receipt in receipts)
            if job in ('gate', 'e2e-live'):
                failed = any(any(item['name'] == gate and item['conclusion'] == 'failure' for item in pages(f'repos/{repository}/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100', 'jobs')) for run in runs if run['head_sha'] == sha)
            if not failed or not waived(repository, candidate, sha, workflow, job):
                missing.append(f'{workflow}/{job}')
    if missing:
        raise ValueError('Integration proof missing: ' + ', '.join(missing))


if __name__ == '__main__':
    tag = os.environ['GITHUB_REF_NAME']
    if not re.fullmatch(r'v\d+\.\d+\.\d+(-preview\.\d+)?', tag):
        raise ValueError(f'Invalid release tag: {tag}')
    check(os.environ['GITHUB_REPOSITORY'], tag[1:], changes.command('git', 'rev-parse', 'HEAD'))
