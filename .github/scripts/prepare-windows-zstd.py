"""Expose an existing or checksum-pinned portable compressor for this job only."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

VERSION = '1.5.7'
ASSET = f'zstd-v{VERSION}-win64.zip'
SHA256 = 'acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9'
URL = f'https://github.com/facebook/zstd/releases/download/v{VERSION}/{ASSET}'


def unpack(archive, root):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise ValueError('Portable zstd release checksum mismatch')
    with zipfile.ZipFile(archive) as package:
        executable = package.read(f'zstd-v{VERSION}-win64/zstd.exe')
    target = root / 'zstd.exe'
    target.write_bytes(executable)
    archive.unlink()
    return target


def prepare():
    executable = shutil.which('zstd')
    if not executable:
        root = Path(tempfile.mkdtemp(prefix='zstd-', dir=os.environ['RUNNER_TEMP']))
        archive = root / ASSET
        with urllib.request.urlopen(URL, timeout=120) as response:
            archive.write_bytes(response.read())
        executable = str(unpack(archive, root))
    # Exercise both operations used by Cargo snapshots before any build starts.
    original = b'Butler complete Cargo snapshot compressor check\n' * 16
    compressed = subprocess.run([executable, '-T2', '-3', '-c'], input=original,
                                capture_output=True, check=True, timeout=30).stdout
    restored = subprocess.run([executable, '-d', '-c'], input=compressed,
                              capture_output=True, check=True, timeout=30).stdout
    if restored != original:
        raise ValueError('Portable zstd roundtrip mismatch')
    print(str(Path(executable).parent))


if __name__ == '__main__':
    prepare()
