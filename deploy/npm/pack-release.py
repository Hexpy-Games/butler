#!/usr/bin/env python3
"""Build and verify an npm asset from an immutable tag; never publish to npm."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('tag')
parser.add_argument('output', type=Path)
args = parser.parse_args()
assert re.fullmatch(r'v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', args.tag), 'Expected a version tag'
version = args.tag[1:]
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='npm-release-', dir=os.environ.get('RUNNER_TEMP', os.environ.get('TMPDIR', '/tmp'))) as directory:
    scratch = Path(directory)
    archive = scratch / 'source.tar'
    with archive.open('wb') as destination:
        subprocess.run(['git', 'archive', args.tag], stdout=destination, check=True)
    source = scratch / 'source'
    source.mkdir()
    with tarfile.open(archive) as contents:
        contents.extractall(source, filter='data')
    package = source / 'packages/butler-npm'
    manifest = package / 'package.json'
    document = json.loads(manifest.read_text())
    assert document['name'] == '@hexpygames/butler'
    document['version'] = version
    manifest.write_text(json.dumps(document, indent=2) + '\n')
    result = subprocess.run(['npm', 'pack', '--json', '--pack-destination', str(output)], cwd=package, check=True, text=True, stdout=subprocess.PIPE)
    # Lifecycle scripts (prepack) print to stdout before npm's --json array; parse from the array's first line.
    lines = result.stdout.splitlines(keepends=True)
    start = next((index for index, line in enumerate(lines) if line.startswith('[')), None)
    if start is None:
        raise SystemExit(f'npm pack --json printed no JSON array; stdout was:\n{result.stdout}')
    records = json.loads(''.join(lines[start:]))
    assert len(records) == 1
    artifact = output / records[0]['filename']
    assert artifact.name == f'hexpygames-butler-{version}.tgz'
    with tarfile.open(artifact, 'r:gz') as contents:
        def read(name):
            member = contents.extractfile(f'package/{name}')
            assert member is not None, name
            return member.read()
        assert json.loads(read('package.json'))['version'] == version
        for name, original in [('bin/butler-install.js', package / 'bin/butler-install.js'), ('install.sh', source / 'deploy/install.sh'), ('install.ps1', source / 'deploy/install.ps1')]:
            assert read(name) == original.read_bytes(), name
        assert gzip.decompress(read('THIRD_PARTY_NOTICES.txt.gz')) == (source / 'deploy/licenses/THIRD_PARTY_NOTICES.txt').read_bytes()
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    artifact.with_name(artifact.name + '.sha256').write_text(f'{digest}  {artifact.name}\n')
    print(f'PASS npm release asset {artifact.name}: immutable source, exact version/installers/wrapper and complete notices')
