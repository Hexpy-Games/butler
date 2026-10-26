#!/usr/bin/env python3.12
"""Offline report contracts, including asks, invalid runs and cache pricing."""
import json
import os
import subprocess
from pathlib import Path
import tempfile
import sys

sys.dont_write_bytecode = True
import delegation_eval_report as report


def runner_variants(runner=None):
    scripts = Path(__file__).resolve().parent
    runner = runner or scripts/'delegation_eval.sh'
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        commands = root/'bin'
        commands.mkdir()
        cargo = commands/'cargo'
        cargo.write_text('#!/bin/sh\nprintf "%s\\n" "$BUTLER_E2E_DELEGATION_VARIANT" >> "$EVAL_VARIANT_LOG"\n')
        cargo.chmod(0o700)
        for side in ('old', 'new'):
            binary = root/('target-old' if side == 'old' else 'target-new')/'debug/butler-agent'
            binary.parent.mkdir(parents=True)
            binary.touch(mode=0o700)
        env = dict(os.environ, PATH=str(commands)+os.pathsep+os.environ['PATH'],
                   BUTLER_E2E_DELEGATION_ROOT=str(root), CARGO_TARGET_DIR=str(root/'target-new'),
                   BUTLER_E2E_API_KEY_ENV='EVAL_DUMMY_KEY', EVAL_DUMMY_KEY='dummy',
                   EVAL_VARIANT_LOG=str(root/'variants'))
        subprocess.run(['bash', str(runner), 'steward', '--model', 'anthropic/test',
                        '--variants', 'old,new', '--cases', 'w07-small-fix'], env=env,
                       check=True, stdout=subprocess.DEVNULL)
        assert (root/'variants').read_text().splitlines() == ['old', 'new']


def failures(base):
    scenarios = [({'timed_out': True}, 'timeout'),
                 ({'error': 'private tool arguments'}, 'harness_error: unspecified'),
                 ({'error': 'private tool arguments', 'harness_error_reason': 'database_snapshot'},
                  'harness_error: database_snapshot'),
                 ({'samples': []}, 'no_upstream_samples'),
                 ({'terminal_result': False}, 'missing_agent_terminal_result')]
    for fields, reason in scenarios:
        row = json.loads(json.dumps(base))
        row.update(fields)
        assert report.enrich(row, {})['invalid_reason'] == reason
        assert row['outcome'] == 'invalid'
    for field, value, reason in [('http_status', 500, 'upstream_http_error'),
                                  ('complete', False, 'missing_upstream_terminal_result')]:
        row = json.loads(json.dumps(base))
        row['samples'][0][field] = value
        assert report.enrich(row, {})['invalid_reason'] == reason
    mismatch = json.loads(json.dumps(base))
    mismatch['samples'][0]['usage']['output_items'] = [{'id': 'fc_missing', 'output_tokens': 41}]
    assert report.enrich(mismatch, {})['extraction_mismatch'] is True
    assert mismatch['invalid_reason'] == 'extraction_mismatch'
    limited = json.loads(json.dumps(base))
    limited['round_limit'] = True
    assert report.enrich(limited, {})['outcome'] == 'limit_hit'
    assert limited['invalid_reason'] is None
    groups = report.aggregate([limited, mismatch])
    assert groups[0]['invalid'] == 1
    assert groups[0]['limit_hits'] == 1
    steward = json.loads(json.dumps(base))
    steward.update(mode='steward', variant='old', db=dict(plan_before_first_mutation=True))
    group = report.aggregate([report.enrich(steward, {})])[0]
    assert group['plan_gate_refusals'] == 0
    assert group['plan_before_first_mutation'] == dict(passed=1, scored=1)


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
    failures(rows[1])
    with tempfile.TemporaryDirectory() as temp:
        groups, _ = report.report(rows, dict(models=[dict(model_ref='test/model', pricing=p)]), Path(temp))
        assert groups[0]['accuracy'] == 1
        assert groups[0]['delegate_recall'] == 1
        assert groups[0]['false_delegation_rate'] == 0
        assert json.loads((Path(temp)/'results.json').read_text())['cases'][0]['first_call'] == 'delegate_to_steward'
        assert 'delegate' in (Path(temp)/'summary.md').read_text()
    runner_variants()
    print('delegation report smoke passed')


if __name__ == '__main__':
    main()
