"""Content-addressed native SDK release assets; published releases are never modified."""
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


def release(fingerprint, target):
    tag, asset = names(fingerprint, target)
    url = f'https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}'
    try:
        with request(url) as response:
            metadata = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise RuntimeError(f'Native release lookup failed: HTTP {error.code}') from None
    if metadata['draft']:
        raise RuntimeError('Native release is still a draft')
    matches = [item for item in metadata['assets'] if item['name'] == asset]
    if len(matches) != 1:
        raise RuntimeError('Published native release has no unique matching asset')
    entry = matches[0]
    digest = entry.get('digest', '')
    if not digest.startswith('sha256:') or len(digest) != 71:
        raise RuntimeError('Native asset has no GitHub-recorded SHA-256')
    return entry


def download_asset(entry, destination):
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
    (stage / 'build/_deps').symlink_to('Release/_deps', target_is_directory=True)


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
    print('Verified and extracted pinned native release asset', file=sys.stderr)
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
    """Only the producer calls this; upload to a draft, then publish once."""
    fingerprint = subprocess.check_output([sys.executable, str(script), '--target', target, '--fingerprint'], text=True).strip()
    if release(fingerprint, target) is not None:
        print('Native release already published; no build or mutation')
        return
    result = json.loads(subprocess.check_output([sys.executable, str(script), '--target', target, '--build-only'], text=True))
    complete = Path(result['ort_lib_path']).parent.parent
    tag, asset = names(fingerprint, target)
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary) / asset
        pack(complete, archive)
        gh = ['gh', 'release']
        subprocess.run([*gh, 'create', tag, '--repo', REPOSITORY, '--target', os.environ['GITHUB_SHA'],
                        '--draft', '--prerelease', '--latest=false', '--title', tag,
                        '--notes', f'Pinned native SDK for {target}. Key: {fingerprint}.'], check=True)
        subprocess.run([*gh, 'upload', tag, str(archive), '--repo', REPOSITORY], check=True)
        subprocess.run([*gh, 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest=false'], check=True)


if __name__ == '__main__':
    from static_ort_targets import TARGETS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['publish'])
    parser.add_argument('target', choices=sorted(TARGETS))
    args = parser.parse_args()
    publish(Path(__file__).with_name('prepare-static-ort.py'), args.target)
