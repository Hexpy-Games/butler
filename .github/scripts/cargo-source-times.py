#!/usr/bin/env python3
"""Restore freshness only for tracked inputs with identical complete contents.

Cargo's source freshness uses mtimes. A new checkout otherwise invalidates
unchanged workspace libraries in either complete snapshot restore path. Changed inputs
stay newer than the snapshot; revision/version environment checks still run.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def tracked(root):
    result = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z'])
    return {os.fsdecode(path) for path in result.split(b'\0') if path}


def safe_path(root, name):
    relative = Path(name)
    if not relative.parts or relative.is_absolute() or '..' in relative.parts or '.git' in relative.parts:
        raise ValueError('Invalid cached source path')
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Escaping cached source path')
    return path


def checksum(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def directory_digests(root, files):
    """Prove complete membership and contents; unknown entries never qualify."""
    parents = {str(parent) for name in files for parent in Path(name).parents if parent != Path('.')}
    digests = {}
    for name in sorted(parents, key=lambda name: len(Path(name).parts), reverse=True):
        path = safe_path(root, name)
        if not path.is_dir():
            continue
        entries = []
        for child in sorted(path.iterdir()):
            relative = str(child.relative_to(root))
            if child.is_symlink():
                break
            value = digests.get(relative) if child.is_dir() else files.get(relative)
            if value is None:
                break
            entries.append((child.name, 'directory' if child.is_dir() else 'file', value))
        else:
            content = json.dumps(entries, separators=(',', ':')).encode()
            digests[name] = hashlib.sha256(content).hexdigest()
    return digests


def capture(root):
    entries = []
    for name in sorted(tracked(root)):
        path = root / name
        if path.is_file() and not path.is_symlink():
            safe_path(root, name)
            entries.append(dict(path=name, sha256=checksum(path), mtime_ns=path.stat().st_mtime_ns))
    files = {entry['path']: entry['sha256'] for entry in entries}
    for name, digest in directory_digests(root, files).items():
        entries.append(dict(path=name, kind='directory', sha256=digest,
                            mtime_ns=(root / name).stat().st_mtime_ns))
    return entries


def build_key(root):
    """Roll main snapshots on build inputs, never on git HEAD or job/ref names."""
    scopes = ('packages/butler-agent/rust/', 'packages/butler-agent/resources/',
              'packages/butler-app/client/electron/', 'packages/butler-app/scripts/release/')
    inputs = [(entry['path'], entry['sha256']) for entry in capture(root)
              if entry.get('kind', 'file') == 'file' and entry['path'].startswith(scopes)]
    return hashlib.sha256(json.dumps(inputs, separators=(',', ':')).encode()).hexdigest()


def restore(root, entries):
    names = tracked(root)
    now = time.time_ns()
    matched = 0
    files = {}
    directories = []
    for entry in entries:
        path = safe_path(root, entry['path'])
        stamp = entry['mtime_ns']
        if type(stamp) is not int or stamp < 0 or stamp > now:
            raise ValueError('Invalid cached source timestamp')
        if entry.get('kind') == 'directory':
            directories.append(entry)
            continue
        if entry.get('kind', 'file') != 'file':
            raise ValueError('Invalid cached source kind')
        if entry['path'] not in names or not path.is_file():
            continue
        # Full contents are checked, including fixtures/resources and manifests.
        # Round down to tar's second precision, always before compiled outputs.
        files[entry['path']] = checksum(path)
        identical = files[entry['path']] == entry['sha256']
        source_time = stamp // 1_000_000_000 * 1_000_000_000 if identical else now
        os.utime(path, ns=(path.stat().st_atime_ns, source_time))
        matched += identical
    # Newly tracked inputs have no producer timestamp. Explicitly dirty them,
    # even if a checkout or local caller supplied an older mtime.
    for name in names - files.keys():
        path = safe_path(root, name)
        if path.is_file():
            files[name] = checksum(path)
            os.utime(path, ns=(path.stat().st_atime_ns, now))
    current = directory_digests(root, files)
    matched_directories = 0
    for entry in directories:
        path = safe_path(root, entry['path'])
        if not path.is_dir():
            continue
        identical = current.get(entry['path']) == entry['sha256']
        stamp = entry['mtime_ns'] // 1_000_000_000 * 1_000_000_000 if identical else now
        os.utime(path, ns=(path.stat().st_atime_ns, stamp))
        matched_directories += identical
    print(f'Validated contents and restored freshness for {matched} unchanged tracked inputs '
          f'and {matched_directories} complete directories.')
