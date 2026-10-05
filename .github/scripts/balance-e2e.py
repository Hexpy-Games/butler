#!/usr/bin/env python3
"""Assign every ordinary E2E exactly once, using measured longest-first loads."""
import re
import json
from pathlib import Path
import sys

inventory = json.loads(Path(sys.argv[1]).read_text())
measurements = json.loads(Path(__file__).with_name('e2e-durations.json').read_text())
durations = measurements['seconds']
perf_durations = measurements['perf_seconds']
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

# The performance inventory is obtained with the existing budget-helper filter,
# so moving a test or adding a helper cannot silently narrow its coverage.
perf_inventory = json.loads(Path(sys.argv[3]).read_text())
perf_shards = [[] for _ in range(3)]
perf_loads = [0.0] * 3
perf_cases = []
for suite in perf_inventory['rust-suites'].values():
    if suite['package-name'] != 'butler-e2e':
        continue
    for name, test in suite['testcases'].items():
        if test['filter-match']['status'] != 'matches':
            continue
        if name.startswith(('idle_resources::', 'data_perf::')):
            continue  # Complete libtest observation has its own runner.
        perf_cases.append((perf_durations.get(name, 10.0), suite['binary-name'], name))
for duration, binary, name in sorted(perf_cases, key=lambda item: (-item[0], item[1:])):
    shard = min(range(3), key=lambda index: (perf_loads[index], index))
    perf_shards[shard].append((binary, name))
    perf_loads[shard] += duration
assert len({case for shard in perf_shards for case in shard}) == len(perf_cases)
assert sum(map(len, perf_shards)) == len(perf_cases)
for index, shard in enumerate(perf_shards, 1):
    expression = ' or '.join(f'(binary(={binary}) and test(={name}))' for binary, name in shard)
    (out / f'perf-{index}.txt').write_text(expression or 'none()')
    print(f'perf {index}: {len(shard)} tests, {perf_loads[index - 1]:.3f}s measured duration')
(out / 'perf-selection.json').write_text(json.dumps(perf_shards, indent=2) + '\n')
