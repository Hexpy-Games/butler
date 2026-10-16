"""Authenticated receipt discovery and merge-tree smoke job inputs."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlencode


def trusted_run(run, repository, pr, workflow, branch=None):
    release = pr is None and branch and branch.startswith('release/')
    if release:
        scope = run['event'] in ('push', 'workflow_dispatch') and run.get('head_branch') == branch
        conclusions = ('success', 'failure')
    else:
        scope = (run['event'] == 'pull_request' and any(p['number'] == pr for p in run['pull_requests'])
                 and (branch is None or run.get('head_branch') == branch))
        conclusions = ('success', 'failure')
    return (run['status'] == 'completed' and run['conclusion'] in conclusions
            and scope and run['path'] == f'.github/workflows/{workflow}'
            and run['head_repository']['full_name'] == repository)


def receipt_scope(receipt, run, repository, pr, workflow, branch, base_ref):
    common = (receipt.get('schema') == 1 and receipt.get('pr') == pr
              and receipt.get('repository') == repository and receipt.get('workflow') == workflow
              and receipt.get('run') == run['id'])
    if pr is None:
        return (common and receipt.get('tier') == 'integration' and receipt.get('branch') == branch
                and receipt.get('checkout') == run['head_sha'])
    return (common and bool(branch and base_ref) and receipt.get('tier') == 'smoke'
            and receipt.get('branch') == branch and receipt.get('base_ref') == base_ref
            and receipt.get('head_repository') == repository and receipt.get('head') == run['head_sha'])


def unchanged_ci(run, current_head):
    if not current_head:
        raise ValueError('Current PR head is required for receipt verification')
    # Receipt producers are PR-controlled. Verify their code with Git, not
    # producer-supplied hashes, before trusting any claimed job result.
    for args in [('fetch', '--no-tags', 'origin', run['head_sha']),
                 ('diff', '--quiet', run['head_sha'], current_head, '--', '.github')]:
        subprocess.run(['git', *args], check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)


def previous(repository, pr, workflow, branch, base_ref, api_items, current_head=None):
    query = dict(per_page=100) if pr is None else dict(event='pull_request', per_page=100)
    if branch:
        query['branch'] = branch
    runs = api_items(f'repos/{repository}/actions/workflows/{workflow}/runs?{urlencode(query)}', 'workflow_runs')
    for run in runs:
        if not trusted_run(run, repository, pr, workflow, branch):
            continue
        if pr is not None:
            try:
                unchanged_ci(run, current_head)
            except subprocess.CalledProcessError:
                # A changed or unavailable producer cannot vouch for this run.
                continue
        artifacts = api_items(f'repos/{repository}/actions/runs/{run["id"]}/artifacts?per_page=100', 'artifacts')
        name = f'ci-inputs-{workflow}-{run["run_attempt"]}'
        if not any(a['name'] == name and not a['expired'] for a in artifacts):
            continue
        jobs = api_items(f'repos/{repository}/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100', 'jobs')
        if not any(any(s['name'] == 'Publish successful inputs' and s['conclusion'] == 'success'
                       for s in j.get('steps', [])) for j in jobs):
            continue
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            subprocess.run(['gh', 'run', 'download', str(run['id']), '--name', name, '--dir', directory],
                           check=True, stdout=subprocess.DEVNULL)
            receipt = json.loads((Path(directory) / 'inputs.json').read_text())
        if receipt_scope(receipt, run, repository, pr, workflow, branch, base_ref):
            yield receipt


def passed_job(receipt, name):
    result = receipt.get('job_results', {}).get(name)
    return result == 'success' or (result == 'skipped' and name in receipt.get('job_reuse', {}))


def smoke_inputs(workflow, current, groups, command):
    # Group hashes come from the checked-out PR merge result, so a changed base
    # invalidates exactly the jobs whose consumed content changes. Include CI
    # plumbing conservatively: scripts/actions can import or invoke each other.
    ci_paths = ['.github/scripts', '.github/actions', '.github/workflows']
    plumbing = command('git', 'ls-tree', '-r', 'HEAD', '--', *ci_paths)
    inputs = {name: hashlib.sha256(json.dumps(['smoke-v1', workflow, plumbing,
              [(group, current[group]) for group in names]]).encode()).hexdigest()
              for name, names in groups.items()}
    if 'lint' in inputs:
        inputs['lint'] = hashlib.sha256(json.dumps(['smoke-v1', plumbing,
                         command('git', 'rev-parse', 'HEAD^{tree}')]).encode()).hexdigest()
    return inputs
