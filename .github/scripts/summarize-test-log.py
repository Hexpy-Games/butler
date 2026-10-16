#!/usr/bin/env python3
"""Print libtest failure details and a bounded tail; leave the full log intact."""
from collections import deque
from pathlib import Path
import re
import sys


def summarize(lines, output):
    tail = deque(maxlen=300)
    failure_block = False
    print('Test failure summary:', file=output)
    for line in lines:
        tail.append(line)
        if line.strip() == 'failures:':
            failure_block = True
        if failure_block or re.search(r'test result:|panicked|FAILED', line):
            output.write(line)
        if 'test result:' in line:
            failure_block = False
    print('\nLast 300 lines:', file=output)
    output.writelines(tail)


if __name__ == '__main__':
    sys.stdout.reconfigure(errors='backslashreplace')
    # Windows PowerShell 5.1 redirection writes UTF-16; newer shells use UTF-8.
    path = Path(sys.argv[1])
    with path.open('rb') as source:
        encoding = 'utf-16' if source.read(2) in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    with path.open(encoding=encoding, errors='replace') as source:
        summarize(source, sys.stdout)
