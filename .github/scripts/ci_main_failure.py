"""Main-only failure ranges, issue dedupe and reviewable draft reverts."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def api(path, method='GET', data=None):
    args = ['gh', 'api', path, '--method', method]
    if data is None:
        return json.loads(subprocess.check_output(args, text=True))
    return json.loads(subprocess.check_output(args + ['--input', '-'],
                                             input=json.dumps(data), text=True))


def pages(path):
    result = []
    for page in range(1, 10001):
        value = api(f'{path}{"&" if "?" in path else "?"}per_page=100&page={page}')
        items = value if isinstance(value, list) else value.get('workflow_runs', value.get('jobs', []))
        result.extend(items)
        if len(items) < 100:
            return result
    raise ValueError('Incomplete API pagination')


def trusted(run, repository):
    return (run.get('event') == 'push' and run.get('head_branch') == 'main'
            and run.get('repository', {}).get('full_name', repository) == repository
            and run.get('head_repository', {}).get('full_name') == repository)


def failure_range(repository, run):
    runs = pages(f'repos/{repository}/actions/workflows/{run["workflow_id"]}/runs?branch=main&event=push')
    for earlier in runs:
        if (not trusted(earlier, repository) or earlier['id'] >= run['id']
                or earlier['status'] != 'completed' or earlier['conclusion'] != 'success'):
            continue
        base = earlier['head_sha']
        if subprocess.call(['git', 'merge-base', '--is-ancestor', base, run['head_sha']]) == 0:
            return base, git('rev-list', '--first-parent', '--reverse', f'{base}..{run["head_sha"]}').splitlines()
    raise ValueError('No proven green main ancestor for this workflow; refusing to guess a revert range')


def range_prs(repository, commits):
    merges, prs = [], {}
    for sha in commits:
        parents = git('rev-list', '--parents', '-n', '1', sha).split()[1:]
        associated = pages(f'repos/{repository}/commits/{sha}/pulls')
        for pr in associated:
            if (pr.get('merged_at') and pr.get('base', {}).get('ref') == 'main'
                    and pr.get('base', {}).get('repo', {}).get('full_name') == repository):
                prs[pr['number']] = pr
                if len(parents) == 2 and pr.get('merge_commit_sha') == sha:
                    merges.append((sha, pr['number']))
    return merges, prs


def issue_body(run, base, commits, merges, prs, jobs, marker):
    lines = [marker, f'[{run["name"]} failed]({run["html_url"]})',
             f'Workflow green baseline: `{base}` → `{run["head_sha"]}`', '', 'First-parent commits:']
    lines += [f'- `{sha}`' for sha in commits]
    lines += ['', 'PRs:'] + [f'- #{n}: {pr["html_url"]}' for n, pr in sorted(prs.items())]
    lines += ['', 'Failing jobs:'] + [f'- [{j["name"]}]({j["html_url"]})' for j in jobs if j['conclusion'] == 'failure']
    if base == 'unavailable':
        lines += ['', 'No proven green baseline is available; no revert is proposed.']
    lines += ['', 'Confirm the cause before reverting; no automatic merge.', '```sh']
    lines += [f'git revert -m 1 {sha}' for sha, _ in reversed(merges)]
    return '\n'.join(lines + ['```'])


def draft_revert(repository, run, merges, prs, marker, body):
    if len(prs) != 1 or len(merges) != 1:
        return
    sha, number = merges[0]
    slug = hashlib.sha256(marker.encode()).hexdigest()[:16]
    branch = f'revert/pr-{number}-{slug}'
    existing = pages(f'repos/{repository}/pulls?state=all&head={repository.split("/")[0]}:{branch}')
    if existing:
        return
    git('switch', '-C', branch, 'origin/main')
    git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        '-c', 'core.hooksPath=/dev/null', 'revert', '--no-edit', '-m', '1', sha)
    # Deterministic branch plus workflow concurrency fences interruption/replay.
    remote = git('ls-remote', '--heads', 'origin', f'refs/heads/{branch}')
    if remote:
        git('fetch', 'origin', branch)
        if git('rev-parse', 'HEAD^{tree}') != git('rev-parse', 'FETCH_HEAD^{tree}'):
            raise ValueError('Existing revert branch differs; refusing to overwrite')
    else:
        git('push', 'origin', f'HEAD:refs/heads/{branch}')
    api(f'repos/{repository}/pulls', 'POST', dict(title=f'Revert #{number}: investigate main failure',
        head=branch, base='main', draft=True, body=body))


def report(repository, run):
    if not trusted(run, repository):
        return
    jobs = pages(f'repos/{repository}/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs')
    if not any(job['conclusion'] == 'failure' for job in jobs):
        return
    try:
        base, commits = failure_range(repository, run)
    except ValueError:
        base, commits = 'unavailable', []
    merges, prs = range_prs(repository, commits)
    # Different workflows may share the same baseline and failing SHA. Keep
    # one issue and one draft branch for that range, with separate evidence.
    marker = f'<!-- main-ci-range:{base}:{run["head_sha"]} -->'
    existing = next((i for i in pages(f'repos/{repository}/issues?state=all')
                     if not i.get('pull_request') and marker in (i.get('body') or '')), None)
    start, end = f'<!-- workflow:{run["workflow_id"]} -->', f'<!-- /workflow:{run["workflow_id"]} -->'
    section = issue_body(run, base, commits, merges, prs, jobs, start) + '\n' + end
    body = (existing.get('body') or marker) if existing else marker
    pattern = re.escape(start) + '.*?' + re.escape(end)
    body = re.sub(pattern, lambda match: section, body, flags=re.S) if start in body else body + '\n\n' + section
    if existing:
        api(f'repos/{repository}/issues/{existing["number"]}', 'PATCH', dict(body=body))
    else:
        api(f'repos/{repository}/issues', 'POST', dict(
            title=f'Main CI failure: {base[:8]}..{run["head_sha"][:8]}', body=body))
    draft_revert(repository, run, merges, prs, marker, body)


if __name__ == '__main__':
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if os.environ['GITHUB_EVENT_NAME'] == 'workflow_run':
        report(os.environ['GITHUB_REPOSITORY'], event['workflow_run'])
