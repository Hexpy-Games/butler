#!/usr/bin/env python3
"""Restore freshness only for tracked inputs with identical complete contents.

Cargo's source freshness uses mtimes. A new checkout otherwise invalidates
unchanged workspace libraries in a restored target directory. Changed inputs
stay newer than the snapshot; revision/version environment checks still run.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import time


def tracked(root):
    result = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z'])
    return {os.fsdecode(path) for path in result.split(b'\0') if path}


def safe_path(root, name):
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or '.git' in relative.parts:
        raise ValueError('Invalid cached source path')
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Escaping cached source path')
    return path


def checksum(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def capture(root):
    entries = []
    for name in sorted(tracked(root)):
        path = root / name
        if path.is_file() and not path.is_symlink():
            safe_path(root, name)
            entries.append(dict(path=name, sha256=checksum(path), mtime_ns=path.stat().st_mtime_ns))
    return entries


def restore(root, entries):
    names = tracked(root)
    now = time.time_ns()
    matched = 0
    for entry in entries:
        path = safe_path(root, entry['path'])
        stamp = entry['mtime_ns']
        if type(stamp) is not int or stamp < 0 or stamp > now:
            raise ValueError('Invalid cached source timestamp')
        if entry['path'] not in names or not path.is_file():
            continue
        # Full contents are checked, including fixtures/resources and manifests.
        # Round down to tar's second precision, always before compiled outputs.
        identical = checksum(path) == entry['sha256']
        source_time = stamp // 1_000_000_000 * 1_000_000_000 if identical else now
        os.utime(path, ns=(path.stat().st_atime_ns, source_time))
        matched += identical
    print(f'Validated contents and restored freshness for {matched} unchanged tracked inputs.')
