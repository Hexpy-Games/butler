#!/usr/bin/env python3
"""Restore Cargo outputs when the shared Actions cache has been evicted.

These are build inputs, not a reusable release payload. Cargo still rebuilds
changed sources and the Agent's tracked revision/version inputs. Only successful
native producer jobs in this repository can supply a compatible snapshot.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlencode


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def identity(platform, mode, kind):
    runtime = os.environ.get('ORT_LIB_PATH', '')
    return dict(schema=1, platform=platform, mode=mode, kind=kind,
                compiler=output('rustc', '-vV'),
                runtime=runtime,
                lock=digest(Path('Cargo.lock')), manifest=digest(Path('Cargo.toml')),
                flags={key: value for key, value in os.environ.items()
                       if key.startswith('CARGO_PROFILE_') or key in ['RUSTFLAGS', 'CARGO_BUILD_TARGET']})


def artifact_name(expected):
    key = hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()[:20]
    return f'cargo-build-cache-{expected["platform"]}-{key}'


def valid_producer(run, jobs, repository, platform):
    if run['head_repository']['full_name'] != repository:
        return False
    return any(any(job['name'].endswith(f'{name} ({platform})')
                   for name in ['Build archives', 'Build native Agent', 'Build perf harness'])
               and job['status'] == 'completed' and job['conclusion'] == 'success'
               for job in jobs)


def verify(directory, expected):
    metadata = json.loads((directory / 'cache.json').read_text())
    if metadata['identity'] != expected:
        raise ValueError('Cargo build-cache identity mismatch')
    if digest(directory / 'cache.tar.zst') != metadata['sha256']:
        raise ValueError('Cargo build-cache digest mismatch')


def extract(directory):
    # The producer uploads only its target directory. Reject an unexpected
    # archive root before extraction, even for a same-repository artifact.
    archive = directory / 'cache.tar.zst'
    with subprocess.Popen(['zstd', '-d', '-c', str(archive)], stdout=subprocess.PIPE) as decompress:
        with tarfile.open(fileobj=decompress.stdout, mode='r|') as archive_tar:
            for member in archive_tar:
                path = Path(member.name)
                if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'target':
                    raise ValueError(f'Unexpected Cargo cache path: {member.name}')
                archive_tar.extract(member, filter='data')
        decompress.stdout.close()
        if decompress.wait() != 0:
            raise RuntimeError('Cargo build-cache decompression failed')


def restore(expected):
    repository = os.environ['GITHUB_REPOSITORY']
    query = urlencode(dict(name=artifact_name(expected), per_page=30))
    artifacts = json.loads(output('gh', 'api', f'repos/{repository}/actions/artifacts?{query}'))['artifacts']
    for artifact in artifacts:
        if artifact['expired']:
            continue
        run_id = artifact['workflow_run']['id']
        run = json.loads(output('gh', 'api', f'repos/{repository}/actions/runs/{run_id}'))
        if run['id'] == int(os.environ['GITHUB_RUN_ID']):
            continue
        jobs = json.loads(output('gh', 'api', f'repos/{repository}/actions/runs/{run_id}/jobs?per_page=100'))['jobs']
        if not valid_producer(run, jobs, repository, expected['platform']):
            continue
        with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP']) as temporary:
            subprocess.run(['gh', 'run', 'download', str(run_id), '--name', artifact['name'], '--dir', temporary], check=True)
            verify(Path(temporary), expected)
            extract(Path(temporary))
        print(f'Restored compatible Cargo build inputs from native producer run {run_id}.')
        return
    print('No compatible Cargo artifact snapshot; normal Cargo/cache build follows.')


def record(directory, expected):
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / 'cache.tar.zst'
    with archive.open('wb') as destination:
        tar = subprocess.Popen(['tar', '--exclude=target/debug/incremental',
                                '--exclude=target/release/incremental', '-cf', '-', 'target'], stdout=subprocess.PIPE)
        try:
            subprocess.run(['zstd', '-T2', '-3'], stdin=tar.stdout, stdout=destination, check=True)
        finally:
            tar.stdout.close()
        if tar.wait() != 0:
            raise RuntimeError('Cargo build-cache tar failed')
    metadata = dict(identity=expected, sha=output('git', 'rev-parse', 'HEAD'), sha256=digest(archive))
    (directory / 'cache.json').write_text(json.dumps(metadata, indent=2) + '\n')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output_file:
        output_file.write(f'name={artifact_name(expected)}\n')


if __name__ == '__main__':
    command, platform, mode, kind = sys.argv[1:]
    expected = identity(platform, mode, kind)
    if command == 'restore':
        restore(expected)
    elif command == 'record':
        record(Path(os.environ['RUNNER_TEMP']) / 'cargo-build-cache', expected)
    else:
        raise SystemExit(f'Unknown command: {command}')
