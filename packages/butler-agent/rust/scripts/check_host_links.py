#!/usr/bin/env python3
"""Fail closed on host load paths in native release binaries and bundles."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

MACHO_MAGICS = {
    b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe',
    b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca',
}
LOAD_COMMANDS = {'LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB'}
DYLIB_PREFIXES = ('/usr/lib/', '/System/Library/', '@rpath/', '@executable_path/', '@loader_path/')
RPATH_PREFIXES = ('@executable_path/', '@loader_path/')


def reject(file, path, rule):
    raise RuntimeError(f'{file}: {path!r}: {rule}')


def check_macho(file, libraries, commands):
    # Strip only the metadata suffix: framework and executable names contain spaces.
    for line in libraries.splitlines():
        if not line.startswith((' ', '\t')) or ' (compatibility version ' not in line:
            continue
        path = line.strip().rsplit(' (compatibility version ', 1)[0]
        if not path.startswith(DYLIB_PREFIXES):
            reject(file, path, 'dylib outside allowed load roots')
    command = None
    for line in commands.splitlines():
        text = line.strip()
        if text.startswith('Load command '):
            command = None
        if text.startswith('cmd '):
            command = text[4:]
        if command in LOAD_COMMANDS and text.startswith('name '):
            path = text[5:].rsplit(' (offset ', 1)[0]
            if not path.startswith(DYLIB_PREFIXES):
                reject(file, path, f'{command} outside allowed load roots')
        if command == 'LC_RPATH' and text.startswith('path '):
            path = text[5:].rsplit(' (offset ', 1)[0]
            if not path.startswith(RPATH_PREFIXES):
                reject(file, path, 'LC_RPATH must be executable/loader relative')


def check_elf(file, dynamic):
    for name in re.findall(r'\(NEEDED\).*?\[([^\]]*)\]', dynamic):
        if '/' in name:
            reject(file, name, 'NEEDED must contain no path separator')
    for paths in re.findall(r'\((?:RPATH|RUNPATH)\).*?\[([^\]]*)\]', dynamic):
        for path in paths.split(':'):
            suffix = path.removeprefix('$ORIGIN')
            if not path.startswith('$ORIGIN') or (suffix and not suffix.startswith('/')):
                reject(file, path, 'RPATH/RUNPATH must contain only $ORIGIN-relative entries')


def inspect(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def check_binary(path, platform):
    with path.open('rb') as stream:
        magic = stream.read(4)
    if platform == 'darwin' and magic in MACHO_MAGICS:
        # otool interprets parentheses as archive-member syntax, even in quoted paths.
        with tempfile.TemporaryDirectory(prefix='host-links-') as directory:
            alias = Path(directory) / 'binary'
            alias.symlink_to(path.resolve())
            check_macho(path, inspect(['otool', '-L', str(alias)]), inspect(['otool', '-l', str(alias)]))
        return True
    if platform == 'linux' and magic == b'\x7fELF':
        check_elf(path, inspect(['readelf', '-d', str(path)]))
        return True
    return False


def check_path(root, platform):
    root = Path(root)
    if not root.exists():
        raise RuntimeError(f'{root}: inspection path does not exist')
    if root.is_file():
        if not check_binary(root, platform):
            raise RuntimeError(f'{root}: expected a native {platform} binary')
        return 1
    count = 0
    for current, _, files in os.walk(root, followlinks=False):
        for name in files:
            path = Path(current) / name
            if not path.is_symlink():
                count += check_binary(path, platform)
    if not count:
        raise RuntimeError(f'{root}: no native {platform} binaries found')
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=('darwin', 'linux'), default=sys.platform)
    parser.add_argument('paths', nargs='+', type=Path)
    args = parser.parse_args()
    for path in args.paths:
        try:
            count = check_path(path, args.platform)
        except (OSError, subprocess.CalledProcessError, RuntimeError) as error:
            raise SystemExit(f'Host-link guard failed for {path}: {error}') from error
        print(f'Host-link guard: {path}: checked {count} native files')


if __name__ == '__main__':
    main()
