"""Content-addressed native SDK OCI artifacts; published keys are never modified."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
import zipfile

import ci_oci

REPOSITORY = 'Hexpy-Games/butler'
MAX_BYTES = 2 * 1024**3


def key(script, lock, target):
    inputs = {'lock': lock, 'target': target, 'recipe': {}}
    for path in (script, script.with_name('static_ort_host.py'), Path(__file__).resolve(), script.with_name('static_ort_targets.py'),
                 script.parent.parent / 'rust-toolchain.toml'):
        inputs['recipe'][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()


def names(fingerprint, target):
    return f'native-deps-{fingerprint}', f'native-deps-{target}-{fingerprint}.zip'


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, *args, **kwargs):
        redirected = super().redirect_request(request, *args, **kwargs)
        if redirected is not None:
            redirected.remove_header('Authorization')
        return redirected


def request(url, *, binary=False):
    headers = {'Accept': 'application/octet-stream' if binary else 'application/vnd.github+json',
               'User-Agent': 'butler-native-deps'}
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if token and urllib.parse.urlparse(url).netloc == 'api.github.com':
        headers['Authorization'] = f'Bearer {token}'
    return urllib.request.build_opener(SafeRedirect()).open(
        urllib.request.Request(url, headers=headers), timeout=60)


def release(fingerprint, target, *, anonymous=True):
    reference = f'{ci_oci.REGISTRY}/native-deps:{target}-{fingerprint}'
    if shutil.which('oras') is None:
        return None  # Developer builds can compile the SDK without oras installed.
    published = ci_oci.manifest(reference, anonymous=anonymous)
    if published is None:
        return None
    asset = names(fingerprint, target)[1]
    matches = [entry for entry in published['assets'] if entry['name'] == asset]
    if len(matches) != 1:
        raise RuntimeError('Published native OCI artifact has no unique matching asset')
    return matches[0]


def download_asset(entry, destination):
    if 'reference' in entry:
        ci_oci.fetch(entry, destination)
        return
    if not 0 < entry['size'] <= MAX_BYTES:
        raise RuntimeError('Native asset exceeds size bound')
    if shutil.disk_usage(destination.parent).free <= entry['size'] + 8 * 1024**3:
        raise RuntimeError('Insufficient disk space for native asset')
    digest = hashlib.sha256()
    size = 0
    started = time.monotonic()
    with request(entry['url'], binary=True) as source, destination.open('wb') as output:
        while block := source.read(1024 * 1024):
            if time.monotonic() - started > 20 * 60:
                raise RuntimeError('Native asset download exceeded twenty minutes')
            size += len(block)
            if size > entry['size']:
                raise RuntimeError('Native download exceeds recorded size')
            digest.update(block)
            output.write(block)
    if size != entry['size'] or f'sha256:{digest.hexdigest()}' != entry['digest']:
        raise RuntimeError('Native asset SHA-256/size mismatch')


def unpack(archive, stage):
    with zipfile.ZipFile(archive) as source:
        members = source.infolist()
        total = sum(item.file_size for item in members)
        if sys.platform == 'win32':
            total += sum(item.file_size for item in members if item.filename.startswith('build/Release/_deps/'))
        if total > 4 * 1024**3 or shutil.disk_usage(stage).free <= total + 8 * 1024**3:
            raise RuntimeError('Native asset expansion exceeds disk bound')
        for item in members:
            parts = item.filename.split('/')
            if ('\\' in item.filename or ':' in item.filename or item.filename.startswith('/')
                    or '..' in parts or (item.external_attr >> 16) & 0o170000 == 0o120000):
                raise RuntimeError('Unsafe native archive member')
        if len({item.filename for item in members}) != len(members):
            raise RuntimeError('Duplicate native archive member')
        source.extractall(stage)
        for item in members:
            path = stage / item.filename
            if path.is_file():
                path.chmod((item.external_attr >> 16) & 0o777 or 0o644)
    create_deps_alias(stage / 'build')


def create_deps_alias(build_root):
    """ort-sys expects _deps beside Release; Windows needs no link privilege."""
    if sys.platform == 'win32':
        shutil.copytree(build_root / 'Release/_deps', build_root / '_deps')
    else:
        (build_root / '_deps').symlink_to('Release/_deps', target_is_directory=True)


def deps_content(root):
    """Compare all paths and bytes, including empty directories; reject links."""
    if not root.is_dir() or root.is_symlink():
        raise RuntimeError('ORT dependency copy is missing or linked')
    content = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise RuntimeError('Unexpected link in ORT dependency copy')
        name = path.relative_to(root).as_posix()
        if path.is_dir():
            content[name] = None
        else:
            digest = hashlib.sha256()
            with path.open('rb') as source:
                while block := source.read(1024 * 1024):
                    digest.update(block)
            content[name] = digest.hexdigest()
    return content


def verify_deps_alias(lib_path):
    alias = lib_path.parent / '_deps'
    if sys.platform == 'win32':
        if deps_content(alias) != deps_content(lib_path / '_deps'):
            raise RuntimeError('ORT dependency copy content mismatch')
    elif not alias.is_symlink() or alias.resolve() != (lib_path / '_deps').resolve():
        raise RuntimeError('ort-sys _deps link does not point to Release/_deps')


def restore(root, fingerprint, lock, target, adopt):
    entry = release(fingerprint, target)
    if entry is None:
        return False
    with tempfile.TemporaryDirectory(prefix='.prebuilt-', dir=root) as temporary:
        archive = Path(temporary) / 'sdk.zip'
        stage = Path(temporary) / 'sdk'
        stage.mkdir()
        download_asset(entry, archive)
        unpack(archive, stage)
        adopt(stage, fingerprint, lock, target)
        stage.rename(root / f'ort-{fingerprint}')
    print('Verified and extracted pinned native OCI artifact', file=sys.stderr)
    return True


def pack(complete, destination):
    record = json.loads((complete / 'complete.json').read_text())
    selected = [complete / 'complete.json', complete / 'build/Release/CMakeCache.txt']
    selected.extend(complete / 'build' / name for name in record['libraries'])
    selected.extend(path for path in (complete / 'downloads').iterdir() if path.is_file())
    selected.extend(path for path in (complete / 'tools/protoc').rglob('*') if path.is_file())
    if sum(path.stat().st_size for path in set(selected)) > 4 * 1024**3:
        raise RuntimeError('Native SDK expansion exceeds consumer bound')
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for path in sorted(set(selected)):
            if path.is_symlink():
                raise RuntimeError('Unexpected link in native SDK asset')
            output.write(path, path.relative_to(complete).as_posix())

    if destination.stat().st_size > MAX_BYTES:
        raise RuntimeError('Native SDK exceeds consumer download bound')


def publish(script, target):
    """A serialized producer commits a complete verified artifact exactly once."""
    fingerprint = subprocess.check_output([sys.executable, str(script), '--target', target, '--fingerprint'], text=True).strip()
    if release(fingerprint, target, anonymous=False) is not None:
        print('Native OCI key already published; no build or mutation')
        return
    result = json.loads(subprocess.check_output([sys.executable, str(script), '--target', target, '--build-only'], text=True))
    complete = Path(result['ort_lib_path']).parent.parent
    asset = names(fingerprint, target)[1]
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary) / asset
        pack(complete, archive)
        reference = f'{ci_oci.REGISTRY}/native-deps:{target}-{fingerprint}'
        ci_oci.push(reference, [archive])
        # Verify the registry's stored blob, not just the local upload descriptor.
        entry = release(fingerprint, target, anonymous=False)
        ci_oci.fetch(entry, Path(temporary) / 'verified.zip', anonymous=False)
        print(f'Published verified {reference}')


if __name__ == '__main__':
    from static_ort_targets import TARGETS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['publish'])
    parser.add_argument('target', choices=sorted(TARGETS))
    args = parser.parse_args()
    publish(Path(__file__).with_name('prepare-static-ort.py'), args.target)
