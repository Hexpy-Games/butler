"""Discover repository inputs consumed outside the Rust workspace.

Includes are relative to their source; build-script paths are relative to the
crate. Keep directory declarations as prefixes, so additions and deletions also
invalidate archives. Discovery runs once per selector process, never per path.
"""
from functools import lru_cache
from pathlib import Path
import re

RUST = 'packages/butler-agent/rust'
STRINGS = re.compile(r'"([^"\n]*)"')
INCLUDES = re.compile(r'\binclude(?:_str|_bytes)?!\s*\(\s*(?:r#*)?"([^"\n]+)"')


def external_path(root, rust, base, value):
    path = (base / value).resolve()
    if path.is_relative_to(root) and not path.is_relative_to(rust):
        return path.relative_to(root).as_posix()
    return None


@lru_cache(maxsize=None)
def external_inputs(repository):
    root = Path(repository).resolve()
    rust = root / RUST
    inputs = set()
    for source in rust.rglob('*.rs'):
        text = source.read_text(encoding='utf-8')
        for value in INCLUDES.findall(text):
            path = external_path(root, rust, source.parent, value)
            if path:
                inputs.add(path)
        if source.name != 'build.rs':
            continue
        # Conservatively retain all repository path literals in build scripts:
        # file reads, directory walks, rerun declarations and their constants.
        for value in STRINGS.findall(text):
            value = value.removeprefix('cargo:rerun-if-changed=')
            if value.startswith('../'):
                base = source.parent
            elif value.startswith('packages/'):
                base = root
            else:
                continue
            path = external_path(root, rust, base, value)
            if path:
                inputs.add(path)
    return frozenset(inputs)


def consumes(path, repository):
    return any(path == item or path.startswith(item + '/')
               for item in external_inputs(str(repository)))
