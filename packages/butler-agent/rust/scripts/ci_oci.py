"""Verified OCI file transport; readers always use an empty credential file."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

REGISTRY = 'ghcr.io/hexpy-games/butler-ci'
SOURCE = 'https://github.com/Hexpy-Games/butler'
MAX_BYTES = 2 * 1024**3


def digest(path):
    with path.open('rb') as stream:
        return 'sha256:' + hashlib.file_digest(stream, 'sha256').hexdigest()


def command(*args, anonymous=True, cwd=None):
    with tempfile.TemporaryDirectory() as temporary:
        credentials = Path(temporary) / 'config.json'
        credentials.write_text('{"auths":{}}')
        options = ['--oci-layout'] if os.environ.get('BUTLER_OCI_LAYOUT') == '1' else []
        if anonymous:
            options += ['--registry-config', str(credentials)]
        elif os.environ.get('BUTLER_OCI_LAYOUT') != '1':
            config = os.environ.get('BUTLER_OCI_AUTH_CONFIG')
            if not config:
                raise RuntimeError('Publisher requires an isolated OCI credential file')
            options += ['--registry-config', config]
        return subprocess.run(['oras', *args, *options], cwd=cwd, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1200)


def checked(*args, **kwargs):
    result = command(*args, **kwargs)
    if result.returncode:
        raise RuntimeError(f'OCI {args[0]} failed: {result.stderr.strip()}')
    return result.stdout


def manifest(reference, *, anonymous=True):
    if os.environ.get('BUTLER_OCI_LAYOUT') == '1' and not Path(reference.rsplit(':', 1)[0]).exists():
        return None
    result = command('manifest', 'fetch', reference, anonymous=anonymous)
    if result.returncode:
        if any(code in result.stderr.lower() for code in ['not found', 'manifest_unknown', 'name_unknown', '404']):
            return None
        if anonymous and 'requested access to the resource is denied' in result.stderr:
            print('OCI package is absent or not public; cold build follows.')
            return None
        raise RuntimeError(f'OCI manifest lookup failed: {result.stderr.strip()}')
    value = json.loads(result.stdout)
    files = {}
    for layer in value['layers']:
        name = layer.get('annotations', {}).get('org.opencontainers.image.title', '')
        if not name or Path(name).name != name or '\\' in name or ':' in name or name in files:
            raise ValueError('Unsafe or duplicate OCI file name')
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', layer['digest']):
            raise ValueError('OCI file lacks SHA-256')
        if not 0 < layer['size'] <= MAX_BYTES:
            raise ValueError('OCI file exceeds size bound')
        files[name] = dict(layer, name=name, reference=reference.rsplit(':', 1)[0])
    return dict(manifest=value, assets=list(files.values()))


def fetch(entry, destination, *, anonymous=True):
    if not 0 < entry['size'] <= MAX_BYTES:
        raise ValueError('OCI file exceeds size bound')
    if shutil.disk_usage(destination.parent).free <= entry['size'] + 8 * 1024**3:
        raise RuntimeError('Insufficient disk space for OCI file')
    checked('blob', 'fetch', entry['reference'] + '@' + entry['digest'],
            '--output', str(destination), anonymous=anonymous)
    if destination.stat().st_size != entry['size'] or digest(destination) != entry['digest']:
        raise ValueError('OCI SHA-256/size mismatch')


def push(reference, paths):
    paths = list(paths)
    if not paths or len({path.name for path in paths}) != len(paths):
        raise ValueError('Empty or duplicate OCI files')
    parent = paths[0].parent
    if any(path.parent != parent for path in paths):
        raise ValueError('OCI files must share a staging directory')
    checked('push', reference, '--artifact-type', 'application/vnd.butler.ci.v1',
            '--annotation', 'org.opencontainers.image.source=' + SOURCE,
            *(path.name + ':application/octet-stream' for path in paths),
            anonymous=False, cwd=parent)
    published = manifest(reference, anonymous=False)
    uploaded = {entry['name']: entry for entry in published['assets']}
    if set(uploaded) != {path.name for path in paths}:
        raise ValueError('Published OCI file set mismatch')
    for path in paths:
        if uploaded[path.name]['digest'] != digest(path) or uploaded[path.name]['size'] != path.stat().st_size:
            raise ValueError('Published OCI digest mismatch')
    return published
