"""Discover the shell workspace's transitive path dependencies once per selector."""
from functools import lru_cache
from pathlib import Path
import tomllib

SHELL = 'packages/butler-shell'
DEPENDENCIES = ('dependencies', 'dev-dependencies', 'build-dependencies')


@lru_cache(maxsize=None)
def crate_directories(repository):
    root = Path(repository).resolve()

    @lru_cache(maxsize=None)
    def manifest(crate):
        with (crate / 'Cargo.toml').open('rb') as source:
            return tomllib.load(source)

    @lru_cache(maxsize=None)
    def workspace(crate):
        explicit = manifest(crate).get('package', {}).get('workspace')
        if explicit is not None:
            return (crate / explicit).resolve()
        for parent in (crate, *crate.parents):
            if not parent.is_relative_to(root):
                break
            if (parent / 'Cargo.toml').is_file() and 'workspace' in manifest(parent):
                return parent
        raise ValueError(f'No owning workspace for {crate}')

    pending = [path.parent for path in (root / SHELL).rglob('Cargo.toml')]
    reached = set()
    crates = set()
    while pending:
        crate = pending.pop()
        if crate in reached:
            continue
        reached.add(crate)
        data = manifest(crate)
        if 'package' in data:
            crates.add(crate.relative_to(root).as_posix())
        for table in (data, *data.get('target', {}).values()):
            for kind in DEPENDENCIES:
                for name, dependency in table.get(kind, {}).items():
                    if not isinstance(dependency, dict):
                        continue
                    base = crate
                    if dependency.get('workspace'):
                        base = workspace(crate)
                        dependency = manifest(base)['workspace']['dependencies'][name]
                    if isinstance(dependency, dict) and 'path' in dependency:
                        pending.append((base / dependency['path']).resolve())
    return frozenset(crates)


def consumes(path, repository):
    """Include every file in a reached crate, including assets and deleted files."""
    return any(path == crate or path.startswith(crate + '/')
               for crate in crate_directories(str(repository)))
