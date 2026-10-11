#!/usr/bin/env python3
"""Keep tracked work documents in the Project Ledger, not the source tree."""
import fnmatch
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
ALLOW = (
    'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE*',
    '**/README.md', '**/SKILL.md',
    '**/skills/**/resources/**', '**/skills/**/references/**',
    '.github/releases/**', '.github/ISSUE_TEMPLATE/**', '.github/pull_request_template.md',
    'packages/butler-agent/rust/docs/install-layout.md',
    'packages/butler-agent/rust/docs/install-lifecycle.md',
    'packages/butler-agent/rust/docs/process-names.md',
    'packages/butler-agent/rust/scripts/STANDALONE_AGENT.md',
    'packages/butler-agent/rust/scripts/STATIC_ORT.md',
    'packages/project-ledger/templates/**', 'packages/project-ledger/examples/**',
    '**/fixtures/**', '**/cassettes/**', '**/tests/golden/**',
    'packages/butler-app/client/ui/index.html',
    'packages/butler-app/client/ui/browser-overlay.html',  # Product renderer entry.
    'packages/butler-app/client/ui/lifecycle-assets/lifecycle.html',
    'packages/butler-app/client/ui/ds-site/index.html',
    'packages/butler-app/client/ui/ds-site/host/404.html',
    # Runtime prompts/personas and machine-read contract/ratchet inputs are code assets.
    'packages/butler-agent/resources/eol.md',
    'packages/butler-agent/resources/prompts/*.md',
    'packages/butler-agent/resources/templates/*.md',
    'packages/butler-agent/resources/personas/templates/*/*.md',
    'packages/butler-agent/rust/source-check-tests.txt',
    'packages/butler-agent/rust/crates/*/source-check-baseline.txt',
    'packages/butler-agent/rust/crates/*/os-specific-baseline.txt',
    'packages/butler-agent/rust/crates/*/src/**/wire_codes.txt',
    'packages/butler-agent/rust/crates/butler-models/src/models/catalog/zai-image-model.txt',
    '**/LICENSE*', '**/THIRD_PARTY_NOTICES.*',
)


def main():
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    stray = [path for path in tracked if Path(path).suffix.lower() in ('.md', '.txt', '.html')
             and not any(fnmatch.fnmatchcase(path, glob) for glob in ALLOW)]
    if stray:
        print('Work docs belong in the Project Ledger: ' + ', '.join(stray), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
