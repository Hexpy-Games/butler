#!/usr/bin/env python3
"""Assign every ordinary E2E exactly once, using measured longest-first loads."""
import re
import json
from pathlib import Path
import sys

inventory = json.loads(Path(sys.argv[1]).read_text())
durations = json.loads(Path(__file__).with_name('e2e-durations.json').read_text())['seconds']
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
shards = [[] for _ in range(6)]
loads = [0.0] * 6
cases = []
for suite in inventory['rust-suites'].values():
    if suite['package-name'] != 'butler-e2e':
        continue
    binary = suite['binary-name']
    for name, test in suite['testcases'].items():
        if re.search(r'(^|::)(ins_|perf_)', name) or name.endswith('idle_disk_writes_and_cpu_stay_bounded'):
            continue
        key = name if binary == 'e2e' else f'{binary}::{name}'
        key = key.replace('gateway_pairing::support::', 'gateway_pairing::gateway_pairing::')
        # Unknown tests remain selected, with the measured median rounded up.
        cases.append((durations.get(key, 10.0), binary, name))
for duration, binary, name in sorted(cases, key=lambda item: (-item[0], item[1:])):
    shard = min(range(6), key=lambda index: (loads[index], index))
    shards[shard].append((binary, name))
    loads[shard] += duration
assert sum(map(len, shards)) == len(cases)
assert len({case for shard in shards for case in shard}) == len(cases)
for index, shard in enumerate(shards, 1):
    expression = ' or '.join(f'(binary(={binary}) and test(={name}))' for binary, name in shard)
    (out / f'shard-{index}.txt').write_text(expression or 'none()')
    print(f'shard {index}: {len(shard)} tests, {loads[index - 1]:.3f}s aggregate measured duration')
(out / 'selection.json').write_text(json.dumps(shards, indent=2) + '\n')
