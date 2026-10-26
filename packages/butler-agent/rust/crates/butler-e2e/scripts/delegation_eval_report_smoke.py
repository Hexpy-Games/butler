#!/usr/bin/env python3.12
"""Offline report contracts, including asks, invalid runs and cache pricing."""
import json
from pathlib import Path
import tempfile
import sys

sys.dont_write_bytecode = True
import delegation_eval_report as report


def main():
    assert report.route([]) == 'direct'
    assert report.route([dict(name='ask_user')]) == 'ask'
    assert report.route([dict(name='read_file'), dict(name='start_work')]) == 'delegate'
    assert report.route([dict(name='replace_work_plan', arguments='{"execution_mode":"steward"}')]) == 'delegate'
    assert report.route([dict(name='replace_work_plan', arguments='{"execution_mode":"direct"}')]) == 'direct'
    assert report.usage(dict(usage=dict(input_tokens=10, cache_read_input_tokens=20, cache_creation_input_tokens=5, output_tokens=3))) == dict(input=35, cached=20, cache_write=5, cache_write_1h=0, output=3)
    p = dict(status='published', input_per_mtok_usd=2, cached_input_per_mtok_usd=.1, cache_write_per_mtok_usd=2.5, output_per_mtok_usd=10)
    assert abs(report.cost(dict(input=35, cached=20, cache_write=5, cache_write_1h=0, output=3), p) - .0000645) < 1e-12
    rows = []
    for label in ('delegate', 'direct'):
        rows.append(dict(model='test/model', variant='new', mode='first-decision', case=label, label=label,
                         samples=[dict(calls=[dict(name='delegate_to_steward')] if label=='delegate' else [],
                                       usage=dict(input_tokens=100, output_tokens=20), http_status=200, complete=True)],
                         timed_out=False, round_limit=False, error=None, offline=True, repeat=1, wall_ms=10, db={}))
    with tempfile.TemporaryDirectory() as temp:
        groups, _ = report.report(rows, dict(models=[dict(model_ref='test/model', pricing=p)]), Path(temp))
        assert groups[0]['accuracy'] == 1
        assert groups[0]['delegate_recall'] == 1
        assert groups[0]['false_delegation_rate'] == 0
        assert json.loads((Path(temp)/'results.json').read_text())['cases'][0]['first_call'] == 'delegate_to_steward'
        assert 'delegate' in (Path(temp)/'summary.md').read_text()
    print('delegation report smoke passed')


if __name__ == '__main__':
    main()
