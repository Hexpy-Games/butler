"""Install only the checksum-verified official ORAS executable in job temp."""
import hashlib
import http.client
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

VERSION = '1.2.3'
RELEASE = f'https://github.com/oras-project/oras/releases/download/v{VERSION}'


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


def install():
    system = {'Windows': 'windows', 'Darwin': 'darwin', 'Linux': 'linux'}[platform.system()]
    arch = {'AMD64': 'amd64', 'x86_64': 'amd64', 'arm64': 'arm64', 'aarch64': 'arm64'}[platform.machine()]
    extension = 'zip' if system == 'windows' else 'tar.gz'
    asset = f'oras_{VERSION}_{system}_{arch}.{extension}'
    binary = 'oras.exe' if system == 'windows' else 'oras'
    root = Path(tempfile.mkdtemp(prefix='oras-', dir=os.environ['RUNNER_TEMP']))
    archive = root / asset
    archive.write_bytes(download(f'{RELEASE}/{asset}'))
    checksums = download(f'{RELEASE}/oras_{VERSION}_checksums.txt').decode().splitlines()
    matches = [line.split()[0] for line in checksums if line.split()[-1] == asset]
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if len(matches) != 1 or actual != matches[0]:
        raise ValueError('ORAS release checksum mismatch')
    if extension == 'zip':
        with zipfile.ZipFile(archive) as package:
            executable = package.read(binary)
    else:
        with tarfile.open(archive) as package:
            executable = package.extractfile(binary).read()
    target = root / binary
    target.write_bytes(executable)
    target.chmod(0o755)
    subprocess.run([str(target), 'version'], check=True, timeout=30)
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as output:
        output.write('BUTLER_ORAS_EXECUTABLE=' + str(target) + '\n')
    archive.unlink()
    print(f'Installed {asset}; SHA-256 verified: {actual}')


if __name__ == '__main__':
    install()
