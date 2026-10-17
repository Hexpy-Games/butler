#!/usr/bin/env python3
"""Issue links in PR text: require closing keywords and close release-branch fixes."""
import json
import os
import re
import subprocess
import sys

# GitHub's closing keywords; each one closes only the issue right after it.
CLOSING = r'\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)'
# Explicitly non-closing: the PR advances or relates to an issue that stays open.
NON_CLOSING = r'\b(?:part\s+of|related)'
# Code and HTML comments are not references (hex colors, template guidance).
FENCES = re.compile(r'^(```|~~~).*?(?:^\1|\Z)|<!--.*?-->', re.S | re.M)
INDENTED = re.compile(r'(?:\A|(?<=\n\n))(?:(?: {4}|\t)[^\n]*(?:\n|\Z))+')
INLINE = re.compile(r'`[^`\n]*`')


def ref(repository):
    """`#N`, `owner/repo#N` or the issue URL, for this repository only."""
    repo = re.escape(repository)
    return rf'(?:(?<![\w/#&])#|\b{repo}#|https://github\.com/{repo}/issues/)(\d+)\b'


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


def references(repository, text):
    """(closed, conflicts, loose) issue numbers named in markdown text.

    closed: after a closing keyword only; conflicts: after both a closing and
    a non-closing token; loose: mentioned without either.
    """
    text = re.sub(r'[ \t]+$', '', (text or '').replace('\r\n', '\n'), flags=re.M)
    text = INLINE.sub('', INDENTED.sub('', FENCES.sub('', text)))
    number = ref(repository)
    closing = {int(n) for n in re.findall(rf'{CLOSING}:?\s+{number}', text, re.I)}
    non_closing = {int(n) for n in re.findall(rf'{NON_CLOSING}:?\s+{number}', text, re.I)}
    mentioned = {int(n) for n in re.findall(number, text, re.I)}
    return closing - non_closing, closing & non_closing, mentioned - closing - non_closing


def problems(repository, body):
    _, conflicts, loose = references(repository, body)
    records = {number: issue(repository, number) for number in sorted(loose)}
    unlinked = [n for n, record in records.items() if record and not record.get('pull_request')]
    return sorted(conflicts), unlinked


def close_release_fixes(repository, pr):
    """Close open issues a merged release-branch PR names with a closing keyword."""
    base = pr['base']['ref']
    if not pr.get('merged_at') or not base.startswith('release/'):
        return []
    closed, _, _ = references(repository, f'{pr.get("title") or ""}\n{pr.get("body") or ""}')
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
        conflicts, unlinked = problems(repository, body)
        errors = []
        if conflicts:
            errors.append('Issues named both as fixed and as staying open: '
                          + ', '.join(f'#{n}' for n in conflicts) + '. Keep only one form.')
        if unlinked:
            errors.append('Issues mentioned without a closing keyword: ' + ', '.join(f'#{n}' for n in unlinked)
                          + '. Write "Fixes #N" when this PR resolves the issue, or "Part of #N" or '
                          '"Related #N" when it stays open.')
        if errors:
            sys.exit('\n'.join(errors))
    elif argv[1:2] == ['close'] and len(argv) == 3:
        done = close_release_fixes(repository, api(f'repos/{repository}/pulls/{int(argv[2])}'))
        print('Closed: ' + (', '.join(f'#{n}' for n in done) or 'none'))
    else:
        sys.exit('usage: issue_links.py check | close <pr-number>')


if __name__ == '__main__':
    main(sys.argv)
