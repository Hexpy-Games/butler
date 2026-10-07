"""Install only the checksum-verified official ORAS executable in job temp."""
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

VERSION = '1.2.3'
RELEASE = f'https://github.com/oras-project/oras/releases/download/v{VERSION}'


def install():
    system = {'Windows': 'windows', 'Darwin': 'darwin', 'Linux': 'linux'}[platform.system()]
    arch = {'AMD64': 'amd64', 'x86_64': 'amd64', 'arm64': 'arm64', 'aarch64': 'arm64'}[platform.machine()]
    extension = 'zip' if system == 'windows' else 'tar.gz'
    asset = f'oras_{VERSION}_{system}_{arch}.{extension}'
    binary = 'oras.exe' if system == 'windows' else 'oras'
    root = Path(tempfile.mkdtemp(prefix='oras-', dir=os.environ['RUNNER_TEMP']))
    archive = root / asset
    with urllib.request.urlopen(f'{RELEASE}/{asset}', timeout=120) as response:
        archive.write_bytes(response.read())
    with urllib.request.urlopen(f'{RELEASE}/oras_{VERSION}_checksums.txt', timeout=120) as response:
        checksums = response.read().decode().splitlines()
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
