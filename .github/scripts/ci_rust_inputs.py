"""Discover repository inputs consumed outside the Rust workspace.

Includes are relative to their source; build-script paths are relative to the
crate. Keep directory declarations as prefixes, so additions and deletions also
invalidate archives. Discovery runs once per selector process, never per path.
"""
from functools import lru_cache
import json
from pathlib import Path
import re

RUST = 'packages/butler-agent/rust'
STRINGS = re.compile(r'"([^"\n]*)"')
INCLUDES = re.compile(r'\binclude(?:_str|_bytes)?!\s*\(')
LITERAL = r'(?:r(?P<hashes>\#*)".*?"(?P=hashes)|"(?:\\.|[^"\\])*")'
TOKENS = re.compile(LITERAL + r'|//[^\n]*|/\*.*?\*/|[()]', re.DOTALL)
CONCAT = re.compile(r'concat!\s*\(\s*env!\s*\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*,(.*)\)'
                    r'\s*,?\s*', re.DOTALL)


def include_arguments(text, source):
    for match in INCLUDES.finditer(text):
        depth = 1
        for token in TOKENS.finditer(text, match.end()):
            if token.group() == '(':
                depth += 1
            elif token.group() == ')':
                depth -= 1
            if depth == 0:
                yield text[match.end():token.start()].strip()
                break
        else:
            raise ValueError(f'Unbalanced include argument in {source}')


def literal_value(argument):
    if not re.fullmatch(LITERAL, argument, re.DOTALL):
        return None
    if argument.startswith('r'):
        return argument[argument.index('"') + 1:argument.rindex('"')]
    return json.loads(argument)


def include_path(argument, source, root):
    value = literal_value(argument.removesuffix(',').strip())
    if value is not None:
        return source.parent, value
    if re.search(r'\benv!\s*\(\s*"OUT_DIR"\s*\)', argument):
        return None
    concat = CONCAT.fullmatch(argument)
    if concat:
        suffix = concat[1].strip()
        values = []
        while suffix:
            token = re.match(LITERAL, suffix, re.DOTALL)
            if token is None:
                break
            values.append(literal_value(token.group()))
            suffix = suffix[token.end():].strip()
            if not suffix or suffix == ',':
                crate = next((p for p in source.parents
                              if p.is_relative_to(root) and (p / 'Cargo.toml').is_file()), None)
                if crate is None:
                    raise ValueError(f'No crate Cargo.toml for include in {source}')
                return crate, str(crate) + ''.join(values)
            if not suffix.startswith(','):
                break
            suffix = suffix[1:].strip()
    raise ValueError(f'Unsupported include argument in {source}: {argument}')


def external_path(root, rust, base, value):
    path = (base / value).resolve()
    if path.is_relative_to(root) and not path.is_relative_to(rust):
        return path.relative_to(root).as_posix()
    return None


@lru_cache(maxsize=None)
def external_inputs(repository, crates=(RUST,)):
    root = Path(repository).resolve()
    rust = root / RUST
    inputs = set()
    for source in (path for crate in crates for path in (root / crate).rglob('*.rs')):
        text = source.read_text(encoding='utf-8')
        for argument in include_arguments(text, source):
            resolved = include_path(argument, source, root)
            if resolved is None:
                continue
            base, value = resolved
            path = external_path(root, rust, base, value)
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


def consumes(path, repository, crates=(RUST,)):
    """Whether Rust sources under `crates` read this path outside the workspace."""
    return any(path == item or path.startswith(item + '/')
               for item in external_inputs(str(repository), tuple(crates)))
