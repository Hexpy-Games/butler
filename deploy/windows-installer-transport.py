#!/usr/bin/env python3
"""Transport every installer fixture byte once, with verified Git pack deltas."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import time

NAMES = ('app-windows-first', 'app-windows', 'agent-first', 'installer-contracts')


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def command(args, stdin=None):
    with subprocess.Popen(args, stdin=subprocess.PIPE if stdin else None,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        print(f'INSTALLER-TRANSPORT process_pid={process.pid}', flush=True)
        stdout, stderr = process.communicate(stdin.encode() if stdin else None)
        if process.returncode:
            raise RuntimeError(stderr.decode(errors='replace'))
        return stdout.decode().strip()


def git(repo, *args, stdin=None):
    return command(['git', '-c', 'core.autocrlf=false', '-c', 'core.filemode=false',
                    '-c', 'core.bigFileThreshold=2g', '-c', 'pack.windowMemory=2g',
                    '-c', 'pack.threads=1', '-c', 'pack.compression=1',
                    '-c', 'user.name=Butler artifact transport',
                    '-c', 'user.email=artifacts@invalid.example',
                    f'--git-dir={repo}', *args], stdin)


def inventory(root):
    records = []
    for name in NAMES:
        folder = root / name
        if not folder.is_dir() or folder.is_symlink():
            raise ValueError(f'Missing fixture directory: {name}')
        paths = sorted(folder.rglob('*'))
        files = [path for path in paths if path.is_file()]
        if not files or any(path.is_symlink() for path in paths):
            raise ValueError(f'Incomplete or linked fixture: {name}')
        records.extend(dict(path=path.relative_to(root).as_posix(),
                            bytes=path.stat().st_size, sha256=digest(path)) for path in files)
    return records


def pack(root, output):
    records = inventory(root)
    output.mkdir(parents=True, exist_ok=True)
    bundle = output / 'installers.bundle'
    temporary = os.environ.get('OWNER_JOB_ROOT', os.environ.get('RUNNER_TEMP', os.environ.get('TMPDIR')))
    with tempfile.TemporaryDirectory(prefix='installer-pack-', dir=temporary) as work:
        repo = Path(work) / 'git'
        command(['git', 'init', '--bare', str(repo)])
        git(repo, f'--work-tree={root}', 'add', '--', *NAMES)
        tree = git(repo, 'write-tree')
        commit = git(repo, 'commit-tree', tree, stdin='Complete immutable installer fixtures\n')
        git(repo, 'update-ref', 'refs/heads/transport', commit)
        git(repo, 'bundle', 'create', str(bundle), 'refs/heads/transport')
        metadata = dict(schema=1, commit=commit, bundle_sha256=digest(bundle), files=records)
        (output / 'transport.json').write_text(json.dumps(metadata, sort_keys=True), encoding='utf-8')
    print(f'INSTALLER-TRANSPORT files={len(records)} original_bytes={sum(row["bytes"] for row in records)} packed_bytes={bundle.stat().st_size}', flush=True)


def restore(root, source):
    metadata = json.loads((source / 'transport.json').read_text(encoding='utf-8'))
    bundle = source / 'installers.bundle'
    if metadata['schema'] != 1 or digest(bundle) != metadata['bundle_sha256']:
        raise ValueError('Installer transport checksum mismatch')
    records = metadata['files']
    expected = {row['path'] for row in records}
    if len(expected) != len(records):
        raise ValueError('Duplicate installer file')
    for name in expected:
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name or path.parts[0] not in NAMES:
            raise ValueError('Escaping installer file')
    if any((root / name).exists() for name in NAMES):
        raise ValueError('Installer destination is not fresh')
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='installer-unpack-', dir=os.environ.get('RUNNER_TEMP', os.environ.get('TMPDIR'))) as work:
        repo = Path(work) / 'git'
        command(['git', 'init', '--bare', str(repo)])
        git(repo, 'bundle', 'verify', str(bundle))
        git(repo, 'fetch', str(bundle), 'refs/heads/transport:refs/heads/transport')
        if git(repo, 'rev-parse', 'refs/heads/transport') != metadata['commit']:
            raise ValueError('Installer transport revision mismatch')
        actual = set(git(repo, 'ls-tree', '-rz', '--name-only', metadata['commit']).split('\0')) - {''}
        if actual != expected:
            raise ValueError('Installer transport inventory mismatch')
        modes = git(repo, 'ls-tree', '-r', metadata['commit']).splitlines()
        if any(not line.startswith(('100644 blob ', '100755 blob ')) for line in modes):
            raise ValueError('Installer transport contains non-file objects')
        git(repo, f'--work-tree={root}', 'checkout', metadata['commit'], '--', *NAMES)
    if inventory(root) != records:
        raise ValueError('Reconstructed installer bytes or file count mismatch')
    print(f'INSTALLER-TRANSPORT restored_files={len(records)} verified_bytes={sum(row["bytes"] for row in records)}', flush=True)


if __name__ == '__main__':
    started = time.monotonic()
    mode, destination, transport = sys.argv[1:]
    if mode == 'pack':
        pack(Path(destination).resolve(), Path(transport).resolve())
    elif mode == 'restore':
        restore(Path(destination).resolve(), Path(transport).resolve())
    else:
        raise ValueError('Expected pack or restore')
    print(f'INSTALLER-TRANSPORT mode={mode} seconds={time.monotonic() - started:.3f}', flush=True)
