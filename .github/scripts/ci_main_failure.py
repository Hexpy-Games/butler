"""Main-only failure ranges, issue dedupe, recovery closing and reviewable draft reverts."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

BOT = 'github-actions[bot]'
PASSED = '<!-- passed -->'
SECTION = r'(<!-- workflow:(\d+) -->)(.*?)(<!-- /workflow:\2 -->)'


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def api(path, method='GET', data=None):
    args = ['gh', 'api', path, '--method', method]
    if data is None:
        return json.loads(subprocess.check_output(args, text=True))
    return json.loads(subprocess.check_output(args + ['--input', '-'],
                                             input=json.dumps(data), text=True))


def pages(path):
    for page in range(1, 10001):
        value = api(f'{path}{"&" if "?" in path else "?"}per_page=100&page={page}')
        items = value if isinstance(value, list) else value.get('workflow_runs', value.get('jobs', []))
        yield from items
        if len(items) < 100:
            return
    raise ValueError('Incomplete API pagination')


def trusted(run, repository):
    return (run.get('name') != 'Main CI failure follow-up'
            and run.get('event') == 'push' and run.get('head_branch') == 'main'
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
    branch = f'fix/revert-pr-{number}-{slug}'
    path = f'repos/{repository}/pulls?state=all&head={repository.split("/")[0]}:{branch}'
    if next(iter(pages(path)), None):
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
    # Recheck after Git work: another workflow may have proposed this range.
    if next(iter(pages(path)), None):
        return
    body += ('\n\nThis draft was opened with GITHUB_TOKEN, which does not start pull_request workflows; '
             'required checks may stay Expected.\nTo run CI, push an empty commit from a real account '
             '(`git commit --allow-empty -m "Run CI" && git push`), or close and reopen this PR.\n')
    api(f'repos/{repository}/pulls', 'POST', dict(title=f'Revert #{number}: investigate main failure',
        head=branch, base='main', draft=True, body=body))


def report(repository, run):
    if not trusted(run, repository) or run.get('conclusion') in ('success', 'skipped'):
        return
    jobs = list(pages(f'repos/{repository}/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs'))
    if not any(job['conclusion'] == 'failure' for job in jobs):
        return
    try:
        base, commits = failure_range(repository, run)
    except ValueError:
        base, commits = 'unavailable', []
    merges, prs = range_prs(repository, commits)
    # One issue per green baseline (per workflow when there is none): later
    # failing pushes and other workflows failing since that baseline update
    # it, each with separate evidence. The draft revert stays keyed to the
    # exact range.
    marker = f'<!-- main-ci-range:{base}:{run["head_sha"]} -->'
    family = f'<!-- main-ci-range:{base}:'
    start, end = f'<!-- workflow:{run["workflow_id"]} -->', f'<!-- /workflow:{run["workflow_id"]} -->'
    section = issue_body(run, base, commits, merges, prs, jobs, start) + '\n' + end
    pattern = re.escape(start) + '.*?' + re.escape(end)

    def put_section(body):
        body = body or marker
        if start in body:
            return re.sub(pattern, lambda match: section, body, flags=re.S)
        return body + '\n\n' + section

    def same_failure(issue):
        body = issue.get('body') or ''
        # An issue closed as not planned stays closed; a new failure gets a new issue.
        if family not in body or issue.get('state_reason') == 'not_planned':
            return False
        # Without a green baseline there is no shared range: one issue per workflow.
        return base != 'unavailable' or start in body

    title = f'Main CI failure: {base[:8]}..{run["head_sha"][:8]}'
    # Query the baseline at the mutation boundary, after range discovery.
    existing = next((i for i in bot_issues(repository, 'all') if same_failure(i)), None)
    if existing is None:
        existing = next((i for i in bot_issues(repository, 'all') if same_failure(i)), None)
    if existing:
        body = apply(f'repos/{repository}/issues/{existing["number"]}', put_section,
                     lambda _: dict(title=title, state='open'))
    else:
        body = put_section(marker)
        api(f'repos/{repository}/issues', 'POST', dict(title=title, body=body))
    draft_revert(repository, run, merges, prs, marker, body)


def bot_issues(repository, state):
    # Anyone can open an issue carrying a marker; only the follow-up's own count.
    path = f'repos/{repository}/issues?state={state}&creator={BOT.replace("[", "%5B").replace("]", "%5D")}'
    return (i for i in pages(path)
            if not i.get('pull_request') and (i.get('user') or {}).get('login') == BOT)


def apply(path, change, fields):
    """Write change(body) over the latest body and re-read until it holds.

    Report and resolve runs for different workflows may edit one issue at
    once. A fixed concurrency group would cancel all but one pending run and
    drop evidence, so each writer re-applies its idempotent change to the
    current body until a read after its write still contains it.
    """
    for _ in range(5):
        updated = change(api(path).get('body') or '')
        api(path, 'PATCH', dict(fields(updated), body=updated))
        latest = api(path)
        if change(latest.get('body') or '') == (latest.get('body') or ''):
            return latest.get('body') or ''
    raise RuntimeError(f'{path} kept changing during the follow-up; rerun this job')


def failing_jobs(section):
    """Job names listed under the section's 'Failing jobs:' heading."""
    listed = section.split('Failing jobs:', 1)[1].split('\n\n', 1)[0] if 'Failing jobs:' in section else ''
    return re.findall(r'^- \[(.+)\]\([^)\n]*\)$', listed, re.M)


def resolve(repository, run):
    """Mark this workflow's failures passed; close issues with no failing workflow left."""
    if not trusted(run, repository) or run.get('conclusion') != 'success':
        return
    note = f'{PASSED}\n[{run["name"]} passed]({run["html_url"]})\n'
    start = f'<!-- workflow:{run["workflow_id"]} -->'
    jobs = None

    def mark(match):
        failed = re.search(r'/actions/runs/(\d+)', match[3])
        names = failing_jobs(match[3])
        # A success older than the recorded failure does not resolve it, and a
        # run whose path selection skipped a failed job proves nothing about it.
        if (match[2] != str(run['workflow_id']) or PASSED in match[3] or not names
                or (failed and int(failed[1]) > run['id'])
                or any(jobs.get(name) != 'success' for name in names)):
            return match[0]
        return match[1] + '\n' + note + match[3] + match[4]

    def mark_all(body):
        return re.sub(SECTION, mark, body, flags=re.S)

    def close_when_clear(body):
        if any(PASSED not in match[3] for match in re.finditer(SECTION, body, re.S)):
            return {}
        return dict(state='closed', state_reason='completed')

    for issue in bot_issues(repository, 'open'):
        body = issue.get('body') or ''
        if '<!-- main-ci-range:' not in body or start not in body:
            continue
        if jobs is None:
            jobs = {job['name']: job['conclusion'] for job in
                    pages(f'repos/{repository}/actions/runs/{run["id"]}/jobs?filter=latest')}
        if mark_all(body) == body:
            continue
        path = f'repos/{repository}/issues/{issue["number"]}'
        if close_when_clear(apply(path, mark_all, close_when_clear)):
            api(f'{path}/comments', 'POST', dict(body=f'CI passed again: [{run["name"]}]({run["html_url"]}).'))


if __name__ == '__main__':
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if os.environ['GITHUB_EVENT_NAME'] == 'workflow_run':
        run = event['workflow_run']
        (resolve if run.get('conclusion') == 'success' else report)(os.environ['GITHUB_REPOSITORY'], run)
