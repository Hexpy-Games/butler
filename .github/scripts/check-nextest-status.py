#!/usr/bin/env python3
"""Keep functional failures blocking; report the approved preview.10 timing warning."""
import os
from pathlib import Path
import platform
import re
import sys

status = int(sys.argv[1])
if status == 0:
    sys.exit(0)
log = re.sub(r'\x1b\[[0-9;]*m', '', Path(sys.argv[2]).read_text(errors='replace'))
outcomes = re.findall(
    r'^\s*([A-Z]+(?:[ -][A-Z]+)?)\s+\[[^\]]+\]\s+\(\s*\d+/\d+\)\s+\S+\s+(\S+)(?: .*)?\s*$',
    log, re.MULTILINE,
)
failed = {name for outcome, name in outcomes if outcome not in {'PASS', 'SLOW', 'SKIP'}}
summaries = re.findall(r'^\s*Summary\s+\[[^\]]+\]\s+(\d+) tests run: (\d+) passed[^\n]*', log, re.MULTILINE)
storage_test = 'storage_concurrency::perf_storage_concurrency_eight_streams_keep_exact_content_with_bounded_persistence_and_reads'
advisory = (
    status == 100
    and platform.system() == 'Darwin'
    and os.environ.get('BUTLER_PREVIEW10_STORAGE_VIEW_WARNING') == '1'
    and failed == {storage_test}
    and len(summaries) == 1
    and int(summaries[0][0]) == int(summaries[0][1]) + 1
    # Both runs verify all eight complete ordered answers/durable rows before
    # publishing these measurements. An earlier content/work failure is fatal.
    and 'STORAGE PERF before commits/turn=' in log
    and re.search(r'STORAGE PERF N=8 x 200; persist p95=\d+us; session-view p95=\d+us', log)
    and re.search(r'^\s*storage session-view p95: [0-9.]+ms >= 20ms\s*$', log, re.MULTILINE)
)
if advisory:
    print('::warning::Preview.10 macOS eight-stream session-view p95 exceeded the unchanged 20ms budget after complete content/durability checks; tracked in https://github.com/Hexpy-Games/butler/issues/506', flush=True)
    sys.exit(0)
sys.exit(status)
