#!/usr/bin/env python3
"""Issue links in PR text: require closing keywords and close release-branch fixes."""
import json
import os
import re
import subprocess
import sys

# GitHub's closing keywords; each one closes only the issue right after it.
CLOSING = re.compile(r'\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b', re.I)
# A PR that only advances an issue says so explicitly, so the issue stays open.
PARTIAL = re.compile(r'\bpart of:?\s+#(\d+)\b', re.I)
MENTION = re.compile(r'(?<![\w/#&])#(\d+)\b')
# Code and HTML comments are not references (hex colors, template guidance).
UNREFERENCED = re.compile(r'```.*?```|`[^`\n]*`|<!--.*?-->', re.S)


def api(path, method='GET', data=None):
    args = ['gh', 'api', path, '--method', method]
    if data is None:
        return json.loads(subprocess.check_output(args, text=True))
    return json.loads(subprocess.check_output(args + ['--input', '-'],
                                             input=json.dumps(data), text=True))


def issue(repository, number):
    """The issue or PR record for #number, or None when it does not exist."""
    result = subprocess.run(['gh', 'api', f'repos/{repository}/issues/{number}'],
                            capture_output=True, text=True)
    if result.returncode != 0:
        if 'HTTP 404' in result.stderr or 'HTTP 410' in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip() or f'Issue lookup failed for #{number}')
    return json.loads(result.stdout)


def references(text):
    """(closed, loose): numbers after a closing keyword, and other bare mentions."""
    text = UNREFERENCED.sub('', text or '')
    closed = {int(n) for n in CLOSING.findall(text)}
    partial = {int(n) for n in PARTIAL.findall(text)}
    mentioned = {int(n) for n in MENTION.findall(text)}
    return closed, mentioned - closed - partial


def unlinked_issues(repository, body):
    _, loose = references(body)
    records = {number: issue(repository, number) for number in sorted(loose)}
    return [n for n, record in records.items() if record and not record.get('pull_request')]


def close_release_fixes(repository, pr):
    """Close open issues a merged release-branch PR names with a closing keyword."""
    base = pr['base']['ref']
    if not pr.get('merged_at') or not base.startswith('release/'):
        return []
    closed, _ = references(f'{pr.get("title") or ""}\n{pr.get("body") or ""}')
    done = []
    for number in sorted(closed):
        record = issue(repository, number)
        if not record or record.get('pull_request') or record.get('state') != 'open':
            continue
        path = f'repos/{repository}/issues/{number}'
        api(f'{path}/comments', 'POST', dict(body=f'Fixed by #{pr["number"]} on {base}.'))
        api(path, 'PATCH', dict(state='closed', state_reason='completed'))
        done.append(number)
    return done


def main(argv):
    repository = os.environ['GITHUB_REPOSITORY']
    if argv[1:2] == ['check']:
        with open(os.environ['GITHUB_EVENT_PATH'], encoding='utf-8') as event:
            body = json.load(event)['pull_request'].get('body')
        missing = unlinked_issues(repository, body)
        if missing:
            names = ', '.join(f'#{n}' for n in missing)
            sys.exit(f'Issues mentioned without a closing keyword: {names}. Write "Fixes #N" '
                     'when this PR resolves the issue, or "Part of #N" when the issue stays open.')
    elif argv[1:2] == ['close'] and len(argv) == 3:
        done = close_release_fixes(repository, api(f'repos/{repository}/pulls/{int(argv[2])}'))
        print('Closed: ' + (', '.join(f'#{n}' for n in done) or 'none'))
    else:
        sys.exit('usage: issue_links.py check | close <pr-number>')


if __name__ == '__main__':
    main(sys.argv)
