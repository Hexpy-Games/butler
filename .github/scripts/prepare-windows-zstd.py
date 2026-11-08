"""Expose an existing or checksum-pinned portable compressor for this job only."""
import hashlib
import http.client
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

VERSION = '1.5.7'
ASSET = f'zstd-v{VERSION}-win64.zip'
SHA256 = 'acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9'
URL = f'https://github.com/facebook/zstd/releases/download/v{VERSION}/{ASSET}'


# A release download is idempotent and checksum-verified, so a transient
# GitHub failure (5xx, 429, timeout, dropped connection) is retried.
RETRY_DELAYS = (5, 15, 40, 90)


def transient(error):
    """Timeouts, resets, 429 and 5xx; other answers and TLS trust failures are final."""
    if isinstance(error, urllib.error.HTTPError):
        return error.code >= 500 or error.code == 429
    if isinstance(error, urllib.error.URLError):
        return isinstance(error.reason, Exception) and transient(error.reason)
    return isinstance(error, (TimeoutError, ConnectionError, http.client.IncompleteRead))


def download(url):
    for attempt, delay in enumerate((*RETRY_DELAYS, None), 1):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                return response.read()
        except Exception as error:
            if delay is None or not transient(error):
                raise
            print(f'Download of {url} failed ({error}); retrying in {delay} s '
                  f'(attempt {attempt + 1} of {len(RETRY_DELAYS) + 1}).')
            time.sleep(delay)


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
        archive.write_bytes(download(URL))
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
