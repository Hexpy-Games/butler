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
import shutil
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
    if expected.get('kind') == 'ort':
        return f'static-runtime-{expected["platform"]}-{expected["fingerprint"]}'
    key = hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()[:20]
    return f'cargo-build-cache-{expected["platform"]}-{key}'


def valid_producer(run, jobs, repository, platform, kind):
    if run['head_repository']['full_name'] != repository:
        return False
    names = dict(dev=['Build archives'], perf=['Build perf harness'],
                 native=['Build native Agent', 'Build Linux Agent archive'],
                 ort=['Build native Agent', 'Build Linux Agent archive'])[kind]
    return any((any(job['name'].endswith(f'{name} ({platform})') for name in names)
                or (kind in ['native', 'ort'] and platform == 'darwin-arm64'
                    and job['name'] == 'Build and publish native macOS arm64 artifacts'))
               and job['status'] == 'completed' and job['conclusion'] == 'success'
               for job in jobs)


def verify(directory, expected):
    metadata = json.loads((directory / 'cache.json').read_text())
    if metadata['identity'] != expected:
        raise ValueError('Cargo build-cache identity mismatch')
    if digest(directory / 'cache.tar.zst') != metadata['sha256']:
        raise ValueError('Cargo build-cache digest mismatch')


def extract(directory, root='target'):
    # The producer uploads only its target directory. Reject an unexpected
    # archive root before extraction, even for a same-repository artifact.
    archive = directory / 'cache.tar.zst'
    with subprocess.Popen(['zstd', '-d', '-c', str(archive)], stdout=subprocess.PIPE) as decompress:
        with tarfile.open(fileobj=decompress.stdout, mode='r|') as archive_tar:
            for member in archive_tar:
                path = Path(member.name)
                if member.name == f'._{root}' and member.isfile():
                    # BSD tar's legacy AppleDouble root attributes are data,
                    # not Cargo outputs. Preserve them inside the cache tree;
                    # they must never create a sibling checkout file.
                    with archive_tar.extractfile(member) as metadata:
                        header = metadata.read(8)
                        if header != b'\x00\x05\x16\x07\x00\x02\x00\x00':
                            raise ValueError('Invalid AppleDouble cache root metadata')
                        destination = Path(root) / '._archive_root'
                        if not destination.resolve().is_relative_to(Path(root).resolve()):
                            raise tarfile.FilterError('Escaping cache root metadata')
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        with destination.open('wb') as saved:
                            saved.write(header)
                            shutil.copyfileobj(metadata, saved)
                    continue
                if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != root:
                    raise ValueError(f'Unexpected Cargo cache path: {member.name}')
                if member.issym() or member.islnk():
                    link = Path(member.linkname)
                    destination = path.parent / link if member.issym() else link
                    if link.is_absolute() or not destination.resolve().is_relative_to(Path(root).resolve()):
                        raise tarfile.FilterError(f'Unexpected Cargo cache link: {member.name}')
                archive_tar.extract(member, filter='data')
        decompress.stdout.close()
        if decompress.wait() != 0:
            raise RuntimeError('Cargo build-cache decompression failed')


def restore(expected, root='target'):
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
        if not valid_producer(run, jobs, repository, expected['platform'], expected['kind']):
            continue
        with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP']) as temporary:
            subprocess.run(['gh', 'run', 'download', str(run_id), '--repo', repository, '--name', artifact['name'], '--dir', temporary], check=True)
            verify(Path(temporary), expected)
            extract(Path(temporary), root)
        print(f'Restored compatible Cargo build inputs from native producer run {run_id}.')
        return
    print('No compatible Cargo artifact snapshot; normal Cargo/cache build follows.')


def record(directory, expected, root='target'):
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / 'cache.tar.zst'
    with archive.open('wb') as destination:
        tar = subprocess.Popen(['tar', '--exclude=target/debug/incremental',
                                '--exclude=target/release/incremental', '-cf', '-', root], stdout=subprocess.PIPE,
                               env=dict(os.environ, COPYFILE_DISABLE='1'))
        try:
            subprocess.run(['zstd', '-T2', '-3'], stdin=tar.stdout, stdout=destination, check=True)
        finally:
            tar.stdout.close()
        if tar.wait() != 0:
            raise RuntimeError('Cargo build-cache tar failed')
    metadata = dict(identity=expected, sha=output('git', '-C', os.environ.get('GITHUB_WORKSPACE', str(Path.cwd())), 'rev-parse', 'HEAD'), sha256=digest(archive))
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
