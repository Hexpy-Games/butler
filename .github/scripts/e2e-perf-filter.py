#!/usr/bin/env python3
"""Select whole E2E scenario modules with budget helpers.

Whole modules preserve budgets hidden behind function calls. Pure perf tests
are selected by name as well, including resource/throughput checks. Print the
budget source inventory to stderr so the CI log shows what is enforced.
"""

import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parents[2]
tests = root / "packages/butler-agent/rust/crates/butler-e2e/tests/e2e"
binaries = set()
all_binaries = {source.stem for source in tests.glob("*.rs") if source.stem != "main"}
for source in sorted(tests.rglob("*.rs")):
    text = source.read_text()
    if "assert_wall_clock_budget!" not in text:
        continue
    relative = source.relative_to(tests)
    binary = pathlib.Path(relative.parts[0]).stem
    # Shared support modules can be imported by any binary. Select all rather
    # than silently losing a budget behind an indirect helper call.
    if binary in all_binaries:
        binaries.add(binary)
    else:
        binaries.update(all_binaries)
    for match in re.finditer(r"assert_wall_clock_budget!\s*\(", text):
        line = text.count("\n", 0, match.start()) + 1
        print(f"PERF budget {relative}:{line} (binary {binary})", file=sys.stderr)

if not binaries:
    sys.exit("no wall-clock budget helpers found")
# Preserve the previously selected minimum lock-hold functional assertion.
binaries.add("storage_resilience")
print("test(/(^|::)perf_/) or " + " or ".join(f"test(/^{name}::/)" for name in sorted(binaries)))
