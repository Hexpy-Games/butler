#!/usr/bin/env python3
"""Require an explicit owner-approval marker for DS primitive, block and token changes.

DS primitives and blocks are frozen: changing their styles or structure needs the
owner's approval. DisclosureRow broke three times because its geometry changed
inside unrelated commits (2278cb00b, 92775d8cf) or was patched around in product
code (12ada184c) while the block itself stayed wrong. This check makes the
approval explicit and visible in history.

Approve with either:
  - a commit trailer on any commit in the PR: `DS-Approved: <who, when, where>`
    (survives batch PRs, which re-stack the original commits), or
  - the `ds-approved` PR label.

Showcases, guidance, READMEs and tests are review material, not DS code; they
never need the marker.

  ds-approval.py --pr <number>     (CI; reads the PR through `gh api`)
  ds-approval.py --range BASE..HEAD (local; reads git)
"""
import json
import os
import re
import subprocess
import sys

DS = 'packages/butler-app/client/ui/src/libs/design-system/'
PROTECTED = re.compile(re.escape(DS) + r'(?:(?:components|blocks|shadcn)/.+\.(?:css|tsx?)|[^/]+\.css)$')
REVIEW_ONLY = re.compile(r'\.(?:showcase|guidance|test|fixtures)\.tsx?$')
TRAILER = re.compile(r'^DS-Approved:[ \t]*\S', re.MULTILINE)
LABEL = 'ds-approved'


def protected(paths):
    return sorted(p for p in paths if PROTECTED.match(p) and not REVIEW_ONLY.search(p))


def approved(messages, labels):
    return LABEL in labels or any(TRAILER.search(m) for m in messages)


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def from_pr(number):
    repo = os.environ['GITHUB_REPOSITORY']
    api = lambda path, jq: run('gh', 'api', '--paginate', f'repos/{repo}/{path}', '--jq', jq)
    files = api(f'pulls/{number}/files', '.[].filename').split()
    messages = [json.loads(line) for line in api(f'pulls/{number}/commits', '.[].commit.message | tojson').splitlines() if line]
    labels = api(f'issues/{number}/labels', '.[].name').split()
    return files, messages, labels


def from_range(spec):
    base, head = spec.split('..', 1)
    files = run('git', 'diff', '--name-only', f'{base}...{head}').split()
    messages = [m for m in run('git', 'log', '--format=%B%x00', f'{base}..{head}').split('\0') if m.strip()]
    return files, messages, []


def main(argv):
    if len(argv) != 2 or argv[0] not in ('--pr', '--range'):
        sys.exit(__doc__)
    files, messages, labels = from_pr(argv[1]) if argv[0] == '--pr' else from_range(argv[1])
    changed = protected(files)
    if not changed:
        print('No DS primitive, block or token changes.')
        return 0
    if approved(messages, labels):
        print(f'DS change approved ({len(changed)} file(s)).')
        return 0
    print('DS primitives, blocks or tokens changed without owner approval:', file=sys.stderr)
    for path in changed:
        print(f'  {path}', file=sys.stderr)
    print("\nGet the owner's approval, then add a commit trailer such as\n"
          '  DS-Approved: owner 2026-10-08, proposal <link or commit>\n'
          f'or the `{LABEL}` PR label. Never change a DS primitive to fit one screen.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
