#!/usr/bin/env python3
"""Record complete Cargo build inputs for persistent CI OCI snapshots.

These are build inputs, not a reusable release payload. Cargo still rebuilds
changed sources and the Agent's tracked revision/version inputs. Only successful
native producer jobs in this repository can supply a compatible snapshot.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import tarfile

# Build scripts watch the recipe directory; imports must not create new inputs.
sys.dont_write_bytecode = True

source_spec = importlib.util.spec_from_file_location('source_times', Path(__file__).with_name('cargo-source-times.py'))
source_times = importlib.util.module_from_spec(source_spec)
source_spec.loader.exec_module(source_times)


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def native_identity(platform, target):
    path = Path('scripts/static_ort_host.py')
    if not path.is_file():
        return {}
    spec = importlib.util.spec_from_file_location('native_host', path)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    native = host.host_identity('macos-arm64' if platform == 'darwin-arm64' else platform, target)
    native.pop('python', None)
    return native


def identity(platform, mode, kind):
    runtime = os.environ.get('ORT_LIB_PATH', '')
    compiler = output('rustc', '-vV')
    target = os.environ.get('CARGO_BUILD_TARGET', compiler.split('host: ')[1].splitlines()[0])
    native_compiler = native_identity(platform, compiler.split('host: ')[1].splitlines()[0])
    profile = os.environ.get('TARGET_SNAPSHOT_PROFILE', 'debug' if kind == 'dev' else 'release')
    features = os.environ.get('TARGET_SNAPSHOT_FEATURES',
                              'workspace-defaults' if kind == 'dev' and mode != 'static-ort'
                              else 'workspace-no-defaults,butler-agent/static-ort' if kind == 'dev'
                              else 'butler-agent/' + mode if kind != 'perf' else 'butler-e2e/defaults')
    configs = {str(path): digest(path) for path in [Path('Cargo.toml'), Path('rust-toolchain.toml'),
               Path('.cargo/config.toml'), Path('../../../.cargo/config.toml')]
               if path.is_file()}
    return dict(schema=2, platform=platform, mode=mode, kind=kind, profile=profile,
                features=features, target=target, compiler=compiler, native_compiler=native_compiler, runtime=runtime,
                lock=digest(Path('Cargo.lock')), configs=configs,
                native_recipe={path.name: digest(path) for path in Path('scripts').glob('*')
                               if path.is_file() and (path.name.startswith('static_ort')
                                                      or path.name == 'prepare-static-ort.py')},
                flags={key: value for key, value in os.environ.items()
                       if (key.startswith('CARGO_PROFILE_') or
                           (key.startswith('CARGO_TARGET_') and key != 'CARGO_TARGET_DIR')) or key in
                       ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_TARGET',
                        'ORT_PREFER_DYNAMIC_LINK', 'ORT_SKIP_DOWNLOAD', 'LIBSQLITE3_FLAGS',
                        'CC', 'CXX', 'CFLAGS', 'CXXFLAGS']})


def artifact_name(expected):
    if expected.get('kind') == 'ort':
        return f'static-runtime-{expected["platform"]}-{expected["fingerprint"]}'
    key = hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()[:20]
    return f'cargo-build-cache-{expected["platform"]}-{key}'


def valid_producer(run, jobs, repository, platform, kind):
    if run['head_repository']['full_name'] != repository:
        return False
    names = dict(dev=['Build archives', 'Build target snapshot'], perf=['Build perf harness'],
                 native=['Build native Agent', 'Build Linux Agent archive', 'Build target snapshot'],
                 ort=['Build native Agent', 'Build Linux Agent archive'])[kind]
    return any(((kind in ['dev', 'native', 'perf'] and job['name'].startswith('Build target snapshot ') and job['name'].endswith(f'({platform})'))
                or any(job['name'].endswith(f'{name} ({platform})') for name in names)
                or (kind in ['native', 'ort'] and platform == 'darwin-arm64'
                    and job['name'] == 'Build and publish native macOS arm64 artifacts'))
               and job['status'] == 'completed' and job['conclusion'] == 'success'
               for job in jobs)


def verify(directory, expected):
    metadata = json.loads((directory / 'cache.json').read_text())
    if metadata['identity'] != expected:
        raise ValueError('Cargo build-cache identity mismatch')
    if expected.get('schema') == 2 and not metadata.get('sources_sha256'):
        raise ValueError('Cargo snapshot has no source manifest digest')
    if digest(directory / 'cache.tar.zst') != metadata['sha256']:
        raise ValueError('Cargo build-cache digest mismatch')
    if metadata.get('sources_sha256') and digest(directory / 'sources.json') != metadata['sources_sha256']:
        raise ValueError('Cargo source identity digest mismatch')


def extract(directory, root='target'):
    # The producer uploads only its target directory. Reject an unexpected
    # archive root before extraction, even for a same-repository artifact.
    archive = directory / 'cache.tar.zst'
    cache_root = Path(root)
    if cache_root.is_symlink() or not cache_root.resolve().is_relative_to(Path.cwd().resolve()):
        raise tarfile.FilterError('Escaping cache root')
    with subprocess.Popen(['zstd', '-d', '-c', str(archive)], stdout=subprocess.PIPE) as decompress:
        with tarfile.open(fileobj=decompress.stdout, mode='r|') as archive_tar:
            for member in archive_tar:
                if member.mtime > time.time():
                    raise ValueError('Cargo output has a future timestamp')
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
                if path != cache_root and not path.parent.resolve().is_relative_to(cache_root.resolve()):
                    raise tarfile.FilterError(f'Escaping existing cache path: {member.name}')
                if member.issym() or member.islnk():
                    link = Path(member.linkname)
                    destination = path.parent / link if member.issym() else link
                    if link.is_absolute() or not destination.resolve().is_relative_to(Path(root).resolve()):
                        raise tarfile.FilterError(f'Unexpected Cargo cache link: {member.name}')
                if member.islnk():
                    # Supplementing an existing cache leaves the destination
                    # present. Python 3.12 then falls back to seeking an earlier
                    # tar member, which a zstd stream cannot do. Replace only
                    # the validated in-tree hardlink before recreating it.
                    path.unlink(missing_ok=True)
                archive_tar.extract(member, filter='data')
        decompress.stdout.close()
        if decompress.wait() != 0:
            raise RuntimeError('Cargo build-cache decompression failed')


def record(directory, expected, root='target', target=None):
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / 'cache.tar.zst'
    target = Path(target or root)
    with archive.open('wb') as destination:
        with subprocess.Popen(['zstd', '-T2', '-3'], stdin=subprocess.PIPE, stdout=destination) as compress:
            with tarfile.open(fileobj=compress.stdin, mode='w|', format=tarfile.PAX_FORMAT) as packed:
                def selected(member):
                    if 'incremental' in Path(member.name).parts or 'cargo-timings' in Path(member.name).parts:
                        return None
                    return member
                packed.add(target, arcname=root, filter=selected)
            compress.stdin.close()
            if compress.wait() != 0:
                raise RuntimeError('Cargo snapshot compression failed')
    metadata = dict(producer_name=os.environ.get('TARGET_SNAPSHOT_PRODUCER', ''), runner_kind=os.environ.get('TARGET_SNAPSHOT_RUNNER_KIND', 'hosted'), run_id=os.environ.get('GITHUB_RUN_ID', '0'), run_attempt=os.environ.get('GITHUB_RUN_ATTEMPT', '1'), identity=expected, sha=output('git', '-C', os.environ.get('GITHUB_WORKSPACE', str(Path.cwd())), 'rev-parse', 'HEAD'), sha256=digest(archive))
    if root == 'target':
        sources = directory / 'sources.json'
        sources.write_text(json.dumps(source_times.capture(Path(os.environ['GITHUB_WORKSPACE']))))
        metadata['sources_sha256'] = digest(sources)
    (directory / 'cache.json').write_text(json.dumps(metadata, indent=2) + '\n')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output_file:
        output_file.write(f'name={artifact_name(expected)}\n')


if __name__ == '__main__':
    command, platform, mode, kind = sys.argv[1:]
    expected = identity(platform, mode, kind)
    if command == 'identify':
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write(f'name={artifact_name(expected)}\n')
            stream.write(f'sources={source_times.build_key(Path(os.environ["GITHUB_WORKSPACE"]))}\n')
    elif command == 'restore':
        import importlib
        sys.path.insert(0, str(Path(__file__).parent))
        importlib.import_module('cargo-target-release').restore(expected)
    elif command == 'record':
        record(Path(os.environ['RUNNER_TEMP']) / 'cargo-build-cache', expected, target=os.environ.get('CARGO_TARGET_DIR', 'target'))
    else:
        raise SystemExit(f'Unknown command: {command}')
