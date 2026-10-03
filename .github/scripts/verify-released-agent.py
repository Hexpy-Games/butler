#!/usr/bin/env python3
"""Check the one native Agent archive against published consolidated hashes."""
import hashlib
from pathlib import Path

archives = list(Path.cwd().glob('butler-agent-*.tar.gz'))
checksums = list(Path.cwd().glob('butler-*-SHA256SUMS'))
assert len(archives) == len(checksums) == 1, 'Expected one native archive and checksum manifest'
rows = [line.split() for line in checksums[0].read_text().splitlines() if line.strip()]
matches = [sha for sha, filename in rows if filename.lstrip('*') == archives[0].name]
assert len(matches) == 1, 'Native archive must occur exactly once in published checksums'
with archives[0].open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == matches[0], 'Published archive checksum mismatch'
print(f'Verified published archive {archives[0].name}')
