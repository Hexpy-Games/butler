#!/usr/bin/env python3
"""Fail closed before uploading the one allowlisted, header-free recording."""
import hashlib
import json
from pathlib import Path
import re
import sys


def verify(folder):
    meta = json.loads((folder / 'meta.json').read_text())
    assert meta['scenario'] == 'LIVE-09'
    assert meta['model'] == 'openai/gpt-6-luna'
    assert meta['provider'] == 'openai-subscription'
    assert meta['recorded_at'] and meta['butler_git_sha']
    assert {p.name for p in folder.iterdir()} == {'000.json', 'meta.json'}
    assert len(meta['files']) == 1 and meta['files'][0]['file'] == '000.json'
    raw = (folder / '000.json').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == meta['files'][0]['sha256']
    exchange = json.loads(raw)
    assert exchange['response']['headers'] == []
    forbidden = re.compile(
        r'eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*|\b(?:sk|rk|pk|sess)-[\w-]{16,}'
        r'|\bBearer\s+(?!\{\{)[^\s"\\]+|(?i:authorization|set-cookie|api[_-]?key)'
    )
    assert not forbidden.search(raw.decode()), 'secret/header pattern found'
    secret_fields = {'access_token', 'refresh_token', 'id_token', 'accessToken', 'refreshToken'}

    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in secret_fields:
                    assert child == '{{TOKEN}}', 'unscrubbed token field'
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(exchange)
    for chunk in exchange['response']['chunks']:
        for line in chunk['text'].splitlines():
            if line.startswith('data:'):
                visit(json.loads(line[5:]))
    print('Cassette scrub: 2 JSON files; hashes match; 0 headers; 0 secret findings')


if __name__ == '__main__':
    try:
        verify(Path(sys.argv[1]))
    except (AssertionError, ValueError, OSError, KeyError, IndexError):
        sys.exit('Cassette scrub failed (values withheld)')
