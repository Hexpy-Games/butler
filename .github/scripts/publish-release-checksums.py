#!/usr/bin/env python3
"""Hash every published output, including authorized partial-platform releases."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('tag')
args = parser.parse_args()
assert re.fullmatch(r'v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', args.tag)
repo = os.environ.get('GH_REPO', os.environ.get('GITHUB_REPOSITORY', 'Hexpy-Games/butler'))
records = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/releases?per_page=100']))
release, = [record for record in records if record['tag_name'] == args.tag]
checksum_name = f'butler-{args.tag[1:]}-SHA256SUMS'
assets = {asset['name']: asset for asset in release['assets'] if asset['name'] != checksum_name}
assert assets and len(assets) == len([a for a in release['assets'] if a['name'] != checksum_name])
for required in ['agent-release-manifest.json', 'agent-update-manifest.json', 'install.sh', 'install.ps1']:
    assert required in assets, required
with tempfile.TemporaryDirectory(prefix='release-checksums-', dir=os.environ.get('RUNNER_TEMP', os.environ.get('TMPDIR', '/tmp'))) as directory:
    root = Path(directory)
    subprocess.run(['gh', 'release', 'download', args.tag, '--repo', repo, '--dir', str(root)], check=True)
    files = {file.name for file in root.iterdir() if file.is_file() and file.name != checksum_name}
    assert files == set(assets), 'Published output set changed during download'
    lines = []
    for name, asset in sorted(assets.items()):
        file = root / name
        assert file.stat().st_size == asset['size'], name
        with file.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        assert asset['digest'] == f'sha256:{digest}', name
        lines.append(f'{digest}  {name}\n')
    assert len(lines) == len(assets), 'Every successful output needs one checksum'
    checksum = root / checksum_name
    checksum.write_text(''.join(lines))
    subprocess.run(['gh', 'release', 'upload', args.tag, '--repo', repo, str(checksum), '--clobber'], check=True)
    print(f'PASS {args.tag}: hashed and verified all {len(assets)} successful outputs, then published complete consolidated checksums')
