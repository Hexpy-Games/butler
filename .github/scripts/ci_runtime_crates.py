#!/usr/bin/env python3
"""Windows agent runtime crates, derived from the locked Cargo graph.

`runtime-crates.json` lists every repository crate the Windows agent binary
links (normal and build dependencies, Windows target). The selector reads it;
`--check` regenerates it with `cargo metadata` and fails when it drifted.
"""
from functools import lru_cache
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
RUST = 'packages/butler-agent/rust'
MANIFEST = Path(__file__).resolve().parent / 'runtime-crates.json'
AGENT, TARGET = 'butler-agent', 'x86_64-pc-windows-msvc'
# Workspace-wide build configuration reaches every crate above.
WORKSPACE = tuple(f'{RUST}/{name}' for name in
                  ('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo/config.toml'))


def closure(metadata, root):
    """Repository crate directories the agent package links for the target."""
    packages = {package['id']: package for package in metadata['packages']}
    nodes = {node['id']: node for node in metadata['resolve']['nodes']}
    start = next(i for i in metadata['workspace_members'] if packages[i]['name'] == AGENT)
    seen, stack = set(), [start]
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        stack += [dep['pkg'] for dep in nodes[current]['deps']
                  if packages[dep['pkg']]['source'] is None
                  and any(kind['kind'] in (None, 'build') for kind in dep['dep_kinds'])]
    return sorted(Path(packages[i]['manifest_path']).resolve().parent.relative_to(root).as_posix()
                  for i in seen)


def generate():
    raw = subprocess.check_output(['cargo', 'metadata', '--format-version', '1', '--locked',
                                   '--filter-platform', TARGET], cwd=ROOT / RUST)
    return dict(agent=AGENT, target=TARGET, crates=closure(json.loads(raw), ROOT.resolve()))


@lru_cache(maxsize=None)
def crates():
    return tuple(json.loads(MANIFEST.read_text())['crates'])


def selects(path, consumes):
    """Whether a changed repository path is built into the Windows agent."""
    dirs = crates()
    return (path in WORKSPACE or any(path.startswith(crate + '/') for crate in dirs)
            or consumes(path, ROOT, dirs))


def main(argv):
    current = json.dumps(generate(), indent=2) + '\n'
    if argv == ['--write']:
        MANIFEST.write_text(current)
    elif argv == ['--check']:
        if MANIFEST.read_text() != current:
            return (f'{MANIFEST.name} drifted from the Cargo graph; run '
                    'python3 .github/scripts/ci_runtime_crates.py --write')
    else:
        return 'usage: ci_runtime_crates.py --write|--check'
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
