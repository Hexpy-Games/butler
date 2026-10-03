#!/usr/bin/env python3
"""Record a native build, or reuse a successful same-repository CI artifact.

SHA equality alone is insufficient: version, native mode, profile, assertions,
compiler and flags must also match. A miss builds normally; corruption fails.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def identity(platform, mode, profile, version):
    return dict(schema=1, sha=output('git', 'rev-parse', 'HEAD'), platform=platform,
                native_mode=mode, profile=profile, version=version, toolchain='1.91.0',
                debug_assertions=os.environ.get('CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS', 'false'),
                overflow_checks=os.environ.get('CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS', 'false'),
                rustflags=os.environ.get('RUSTFLAGS', ''),
                lto=os.environ.get('CARGO_PROFILE_RELEASE_LTO', ''),
                codegen_units=os.environ.get('CARGO_PROFILE_RELEASE_CODEGEN_UNITS', ''))


def verify(directory, expected):
    metadata = json.loads((directory / 'provenance.json').read_text())
    if any(metadata.get(key) != value for key, value in expected.items()):
        return False
    filename = 'butler-agent.exe' if expected['platform'] == 'windows-x64' else 'butler-agent'
    if metadata.get('binary') != filename or digest(directory / filename) != metadata.get('sha256'):
        raise ValueError('Matching Agent artifact has invalid binary/digest')
    verify_version(directory / filename, expected['version'])
    return True


def verify_version(binary, version):
    binary.chmod(0o755)
    actual = output(sys.executable, str(Path(__file__).with_name('isolated.py')),
                    str(binary.resolve()), '--version')
    if not actual.startswith(f'butler {version} ('):
        raise ValueError(f'Agent embedded version does not match provenance: {actual}')


def record(directory, expected):
    filename = 'butler-agent.exe' if expected['platform'] == 'windows-x64' else 'butler-agent'
    verify_version(directory / filename, expected['version'])
    metadata = dict(expected, binary=filename, sha256=digest(directory / filename))
    (directory / 'provenance.json').write_text(json.dumps(metadata, indent=2) + '\n')


def reuse(directory, expected):
    repository = os.environ['GITHUB_REPOSITORY']
    endpoint = f'repos/{repository}/actions/workflows/rust-quality.yml/runs?status=success&per_page=30'
    runs = json.loads(output('gh', 'api', endpoint))['workflow_runs']
    for run in runs:
        if run['status'] != 'completed' or run['conclusion'] != 'success':
            continue
        if run['head_repository']['full_name'] != repository:
            continue
        # PR archives can be compiled at the synthetic merge SHA, rather than
        # the head_sha in run metadata. Always compare recorded checkout HEAD.
        if run['head_sha'] != expected['sha'] and run['event'] != 'pull_request':
            continue
        artifacts = json.loads(output('gh', 'api', f'repos/{repository}/actions/runs/{run["id"]}/artifacts?per_page=100'))['artifacts']
        name = f'agent-payload-{expected["platform"]}'
        if not any(a['name'] == name and not a['expired'] for a in artifacts):
            continue
        with tempfile.TemporaryDirectory(dir=os.environ.get('RUNNER_TEMP', os.environ.get('TMPDIR'))) as temporary:
            candidate = Path(temporary)
            subprocess.run(['gh', 'run', 'download', str(run['id']), '--name', name, '--dir', temporary], check=True)
            if not verify(candidate, expected):
                print(f'Run {run["id"]}: incompatible SHA/version/native build; using a native build.')
                continue
            directory.mkdir(parents=True, exist_ok=True)
            filename = 'butler-agent.exe' if expected['platform'] == 'windows-x64' else 'butler-agent'
            shutil.copyfile(candidate / filename, directory / filename)
            (directory / filename).chmod(0o755)
            with open(os.environ['GITHUB_ENV'], 'a') as env:
                env.write(f'BUTLER_NATIVE_AGENT_EXECUTABLE={directory.resolve() / filename}\n')
            print(f'Reusing verified {expected["sha"]} Agent from run {run["id"]}.')
            return True
    print('No compatible exact-commit Agent artifact; building normally.')
    return False


if __name__ == '__main__':
    command, directory, platform, mode, profile, version = sys.argv[1:]
    expected = identity(platform, mode, profile, version)
    if command == 'record':
        record(Path(directory), expected)
    elif command == 'reuse':
        found = reuse(Path(directory), expected)
        with open(os.environ['GITHUB_OUTPUT'], 'a') as result:
            result.write(f'reused={str(found).lower()}\n')
    else:
        raise SystemExit(f'Unknown command: {command}')
