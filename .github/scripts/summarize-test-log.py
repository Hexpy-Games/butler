#!/usr/bin/env python3
"""Print libtest failure details and a bounded tail; leave the full log intact."""
from collections import deque
from pathlib import Path
import re
import sys


def summarize(lines, output):
    tail = deque(maxlen=300)
    failure_block = False
    panic_context = 0
    print('Test failure summary:', file=output)
    for line in lines:
        tail.append(line)
        if line.strip() == 'failures:':
            failure_block = True
        if 'panicked' in line:
            panic_context = 21  # Include this line and the next 20 lines under --nocapture.
        if failure_block or panic_context or re.search(r'test result:|FAILED', line):
            output.write(line)
        panic_context = max(0, panic_context - 1)
        if 'test result:' in line:
            failure_block = False
            panic_context = 0
    print('\nLast 300 lines:', file=output)
    output.writelines(tail)


if __name__ == '__main__':
    sys.stdout.reconfigure(errors='backslashreplace')
    # Native cmd redirection preserves UTF-8; also accept older PowerShell UTF-16 logs.
    path = Path(sys.argv[1])
    with path.open('rb') as source:
        encoding = 'utf-16' if source.read(2) in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    with path.open(encoding=encoding, errors='replace') as source:
        summarize(source, sys.stdout)
