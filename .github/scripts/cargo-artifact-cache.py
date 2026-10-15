#!/usr/bin/env python3
"""Record complete Cargo build inputs for persistent CI OCI snapshots.

These are build inputs, not a reusable release payload. Cargo still rebuilds
changed sources and the Agent's tracked revision/version inputs. Only successful
native producer jobs in this repository can supply a compatible snapshot.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import time
import tarfile
import threading
import tomllib

# Build scripts watch the recipe directory; imports must not create new inputs.
sys.dont_write_bytecode = True

source_spec = importlib.util.spec_from_file_location('source_times', Path(__file__).with_name('cargo-source-times.py'))
source_times = importlib.util.module_from_spec(source_spec)
source_spec.loader.exec_module(source_times)
units_spec = importlib.util.spec_from_file_location('cargo_units', Path(__file__).with_name('cargo_units.py'))
cargo_units = importlib.util.module_from_spec(units_spec)
units_spec.loader.exec_module(cargo_units)


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
    if runtime and mode == 'static-ort':
        # Setup already verifies every SDK library. Its complete manifest, not
        # a runner-specific extraction path, identifies the pinned native bits.
        runtime = {'static_manifest_sha256': digest(Path(runtime).parent.parent / 'complete.json')}
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
                profile_config=(tomllib.loads(Path('Cargo.toml').read_text()).get('profile', {})
                                if Path('Cargo.toml').is_file() else {}),
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


def compatible_identity(expected):
    compatible = dict(expected)
    compatible.pop('lock', None)
    compatible['configs'] = {name: value for name, value in expected.get('configs', {}).items()
                             if Path(name).name != 'Cargo.toml'}
    return compatible


def matches(actual, expected, compatible=False):
    return (compatible_identity(actual) == compatible_identity(expected)
            if compatible else actual == expected)


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


def verify(directory, expected, compatible=False, parts=('cache.tar.zst',)):
    metadata = json.loads((directory / 'cache.json').read_text())
    if not matches(metadata['identity'], expected, compatible):
        raise ValueError('Cargo build-cache identity mismatch')
    if expected.get('schema') == 2 and not metadata.get('sources_sha256'):
        raise ValueError('Cargo snapshot has no source manifest digest')
    if not parts or stream_digest([directory / name for name in parts]) != metadata['sha256']:
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


class Parts:
    """Write one stream as consecutive files of at most `size` bytes, hashing the whole stream.

    Publishing streams compressed output straight into upload-sized parts, so
    the runner never holds a full archive next to a second copy split from it.
    """

    def __init__(self, directory, name, size=None):
        self.directory, self.name, self.size = directory, name, size or sys.maxsize
        self.names, self.hash, self.file, self.used = [], hashlib.sha256(), None, 0

    def write(self, block):
        view = memoryview(block)
        while view:
            if self.file is None or self.used == self.size:
                self.close()
                self.names.append(self.name(len(self.names)))
                self.file, self.used = (self.directory / self.names[-1]).open('wb'), 0
            count = min(len(view), self.size - self.used)
            self.file.write(view[:count])
            self.hash.update(view[:count])
            self.used += count
            view = view[count:]

    def close(self):
        if self.file is not None:
            self.file.close()


def stream_digest(paths):
    """SHA-256 of the files' concatenation: the archive a consumer reassembles."""
    combined = hashlib.sha256()
    for path in paths:
        with path.open('rb') as stream:
            while block := stream.read(8 * 1024**2):
                combined.update(block)
    return combined.hexdigest()


def compress(target, root, parts):
    """Pack `target` as `root` through zstd into `parts` without a temporary archive."""
    stale = cargo_units.stale(Path(target))

    def selected(member):
        if ('incremental' in Path(member.name).parts or 'cargo-timings' in Path(member.name).parts
                or cargo_units.excluded(member.name, stale)):
            return None
        if member.islnk() and cargo_units.excluded(member.linkname, stale):
            # The link's first name stays out of the archive; store this name's own contents.
            member.type, member.linkname = tarfile.REGTYPE, ''
            member.size = Path(target, *PurePosixPath(member.name).parts[1:]).stat().st_size
        return member
    failures = []
    zstd = subprocess.Popen(['zstd', '-T2', '-3'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def drain():
        try:
            while block := zstd.stdout.read(1024**2):
                parts.write(block)
        except BaseException as error:  # Unblock the packer; the write failure is reported.
            failures.append(error)
            zstd.kill()
    thread = threading.Thread(target=drain, daemon=True)
    thread.start()
    try:
        with tarfile.open(fileobj=zstd.stdin, mode='w|', format=tarfile.PAX_FORMAT) as packed:
            packed.add(target, arcname=root, filter=selected)
        zstd.stdin.close()
    except BaseException as error:  # A drain failure comes first; this is its broken pipe.
        zstd.kill()
        failures.append(error)
    finally:
        thread.join()
        parts.close()
        with contextlib.suppress(OSError):
            zstd.stdin.close()
        zstd.stdout.close()
        status = zstd.wait()
    if failures:
        raise failures[0]
    if status:
        raise RuntimeError('Cargo snapshot compression failed')


def record(directory, expected, root='target', target=None, part=None):
    """Snapshot `target`; `part` = (prefix, bytes) writes `<prefix>-NNNN.zst` upload parts instead."""
    directory.mkdir(parents=True, exist_ok=True)
    parts = (Parts(directory, lambda index: f'{part[0]}-{index:04}.zst', part[1]) if part
             else Parts(directory, lambda index: 'cache.tar.zst'))
    compress(Path(target or root), root, parts)
    metadata = dict(producer_name=os.environ.get('TARGET_SNAPSHOT_PRODUCER', ''), runner_kind=os.environ.get('TARGET_SNAPSHOT_RUNNER_KIND', 'hosted'), run_id=os.environ.get('GITHUB_RUN_ID', '0'), run_attempt=os.environ.get('GITHUB_RUN_ATTEMPT', '1'), identity=expected, sha=output('git', '-C', os.environ.get('GITHUB_WORKSPACE', str(Path.cwd())), 'rev-parse', 'HEAD'), sha256=parts.hash.hexdigest())
    if root == 'target':
        sources = directory / 'sources.json'
        sources.write_text(json.dumps(source_times.capture(Path(os.environ['GITHUB_WORKSPACE']))))
        metadata['sources_sha256'] = digest(sources)
    (directory / 'cache.json').write_text(json.dumps(metadata, indent=2) + '\n')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output_file:
        output_file.write(f'name={artifact_name(expected)}\n')
    return parts.names


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
    elif command == 'target':
        import importlib
        print(importlib.import_module('cargo-target-release').persistent_target(expected))
    elif command == 'save-local':
        import importlib
        local = importlib.import_module('cargo-target-release')
        local.save_local(Path(os.environ['CARGO_TARGET_DIR']), expected)
    elif command == 'record':
        record(Path(os.environ['RUNNER_TEMP']) / 'cargo-build-cache', expected, target=os.environ.get('CARGO_TARGET_DIR', 'target'))
    else:
        raise SystemExit(f'Unknown command: {command}')
