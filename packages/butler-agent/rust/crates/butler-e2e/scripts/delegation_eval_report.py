#!/usr/bin/env python3.12
"""Aggregate owner-run delegation evaluations (stdlib only, never a judge)."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path


def usage(sample):
    raw = sample.get('usage') or {}
    cached = raw.get('cache_read_input_tokens', raw.get('input_tokens_details', {}).get('cached_tokens', 0))
    writes = raw.get('cache_creation_input_tokens', 0)
    inp = raw.get('input_tokens', 0)
    # Anthropic's input_tokens excludes both cache categories; Responses includes cached.
    anthropic = 'cache_read_input_tokens' in raw or 'cache_creation_input_tokens' in raw
    return dict(input=inp + cached + writes if anthropic else inp,
                cached=cached, cache_write=writes, cache_write_1h=raw.get('cache_creation', {}).get('ephemeral_1h_input_tokens', 0), output=raw.get('output_tokens', 0))


def cost(tokens, price):
    if price.get('status') != 'published':
        return None
    p = dict(price)
    for tier in price.get('prompt_tiers', []):
        if tokens['input'] > tier['above_input_tokens']:
            p.update(tier)
    normal = max(0, tokens['input'] - tokens['cached'] - tokens['cache_write'])
    return (normal * p['input_per_mtok_usd'] + tokens['cached'] * p.get('cached_input_per_mtok_usd', p['input_per_mtok_usd'])
            + (tokens['cache_write'] - tokens.get('cache_write_1h', 0)) * p.get('cache_write_per_mtok_usd', p['input_per_mtok_usd'])
            + tokens.get('cache_write_1h', 0) * p.get('cache_write_1h_per_mtok_usd', p.get('cache_write_per_mtok_usd', p['input_per_mtok_usd']))
            + tokens['output'] * p['output_per_mtok_usd']) / 1_000_000


def route(calls):
    for call in calls:
        args = call.get('arguments', call.get('input', {}))
        if isinstance(args, str):
            try:
                args = json.loads(args or '{}')
            except json.JSONDecodeError:
                args = {}
        if call['name'] in ('delegate_to_steward', 'start_work', 'continue_work') or (
                call['name'] == 'replace_work_plan' and args.get('execution_mode') == 'steward'):
            return 'delegate'
    return 'ask' if calls and all(c['name'] == 'ask_user' for c in calls) else 'direct'


def has_function_item(value):
    if isinstance(value, dict):
        return (value.get('type') in ('function_call', 'tool_use')
                or str(value.get('id', '')).startswith('fc_')
                or any(has_function_item(v) for v in value.values()))
    if isinstance(value, list):
        return any(has_function_item(v) for v in value)
    return isinstance(value, str) and value.startswith('fc_')


def invalid_reason(row):
    if row.get('timed_out'):
        return 'timeout'
    if row.get('error'):
        return 'harness_error: ' + (row.get('harness_error_reason') or 'unspecified')
    samples = row['samples']
    if not samples:
        return 'no_upstream_samples'
    if any(s['http_status'] != 200 for s in samples):
        return 'upstream_http_error'
    if any(not s['complete'] for s in samples):
        return 'missing_upstream_terminal_result'
    if row.get('extraction_mismatch'):
        return 'extraction_mismatch'
    if row.get('terminal_result') is False and not row['round_limit']:
        return 'missing_agent_terminal_result'
    return row.get('invalid_reason')


def enrich(row, prices):
    samples = row['samples']
    calls = samples[0]['calls'] if samples else []
    row['first_calls'] = [c['name'] for c in calls]
    row['first_call'] = row['first_calls'][0] if calls else None
    row['route'] = route(calls)
    row['first_output_item'] = samples[0].get('first_output_item') if samples else None
    row['extraction_mismatch'] = any(s.get('extraction_mismatch') or (
        not s['calls'] and (has_function_item(s.get('usage')) or has_function_item(s.get('first_output_item')))) for s in samples)
    row['invalid_reason'] = invalid_reason(row)
    row['outcome'] = 'invalid' if row['invalid_reason'] else 'limit_hit' if row['round_limit'] else 'completed'
    row['valid'] = row['outcome'] == 'completed'
    row['tokens'] = dict(Counter({k: sum(usage(s)[k] for s in samples)
                                  for k in ('input', 'cached', 'cache_write', 'cache_write_1h', 'output')}))
    amounts = [cost(usage(s), prices.get(row['model'].split('@')[0], {})) for s in samples]
    row['usd_estimate'] = sum(amounts) if amounts and all(c is not None for c in amounts) else None
    row['rounds'] = len(samples)
    return row


def aggregate(rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row['model'], row['variant'], row['mode'])].append(row)
    groups = []
    for (model, variant, mode), runs in grouped.items():
        group = dict(model=model, variant=variant, mode=mode, runs=len(runs), invalid=sum(r['outcome'] == 'invalid' for r in runs),
                     limit_hits=sum(r['outcome'] == 'limit_hit' for r in runs),
                     invalid_reasons=dict(Counter(r['invalid_reason'] for r in runs if r['invalid_reason'])),
                     extraction_mismatches=sum(r['extraction_mismatch'] for r in runs))
        if mode == 'first-decision':
            confusion = Counter(f"{r['label']}->{r['route']}" if r['valid'] else f"{r['label']}->{r['outcome']}" for r in runs)
            d = sum(r['label'] == 'delegate' for r in runs)
            s = sum(r['label'] == 'direct' for r in runs)
            tp = confusion['delegate->delegate']
            fp = confusion['direct->delegate']
            group.update(confusion={f'{label}->{route}': confusion[f'{label}->{route}']
                                     for label in ('delegate', 'direct') for route in ('delegate', 'direct', 'ask', 'invalid', 'limit_hit')}, delegate_recall=tp/d if d else None,
                         false_delegation_rate=fp/s if s else None,
                         accuracy=(tp+confusion['direct->direct'])/len(runs))
        else:
            group['plan_gate_refusals'] = sum(r['db'].get('plan_gate_refusals', 0) for r in runs)
            for metric in ('plan_before_first_mutation', 'plan_review_accepted', 'workers_when_expected', 'disposition_recorded'):
                scored = [r for r in runs if r['db'].get(metric) is not None]
                group[metric] = dict(passed=sum(r['valid'] and r['db'][metric] for r in scored), scored=len(scored))
        group['tokens'] = {k: sum(r['tokens'][k] for r in runs) for k in ('input', 'cached', 'cache_write', 'cache_write_1h', 'output')}
        amounts = [r['usd_estimate'] for r in runs]
        group['usd_estimate'] = sum(amounts) if all(a is not None for a in amounts) else None
        groups.append(group)
    return groups


def report(rows, catalog, out):
    prices = {m['model_ref']: m.get('pricing', {}) for m in catalog['models']}
    rows = [enrich(r, prices) for r in rows]
    groups = aggregate(rows)
    out.mkdir(parents=True, exist_ok=True)
    (out/'results.json').write_text(json.dumps(dict(groups=groups, cases=rows), ensure_ascii=False, indent=2)+'\n')
    lines = ['# Delegation evaluation', '', 'Offline fake upstream.' if any(r['offline'] for r in rows) else 'Owner-run live results; no cassettes recorded.', '']
    for group in groups:
        lines += [f"## {group['model']} / {group['variant']} / {group['mode']}", '',
                  '```json', json.dumps(group, ensure_ascii=False, indent=2), '```', '']
    lines += ['| Case | Variant | Repeat | Outcome / reason | Route / mode | First output item | First calls / workers | Rounds | Wall ms | USD estimate |',
              '|---|---|---:|---|---|---|---|---:|---:|---:|']
    for r in rows:
        mode = r['route'] if r['mode']=='first-decision' else r['db'].get('chosen_mode')
        detail = ', '.join(r['first_calls']) if r['mode']=='first-decision' else str(r['db'].get('workers'))
        lines.append(f"| {r['case']} | {r['variant']} | {r['repeat']} | {r['outcome']}: {r['invalid_reason'] or ''} | {mode} | {json.dumps(r['first_output_item'], ensure_ascii=False)} | {detail} | {r['rounds']} | {r['wall_ms']} | {r['usd_estimate']} |")
    lines += ['', 'Case checks are report-only: inspect the retained workspace, plans, dispositions and tool results in results.json. No LLM judge.',
              'USD uses repository catalog prices and provider-reported usage; subscription estimates are API-equivalent, not subscription charges.', '']
    summary = out/'summary.md'
    summary.write_text('\n'.join(lines))
    print(summary)
    return groups, rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('--catalog', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    report([json.loads(s) for s in args.input.read_text().splitlines() if s.strip()],
           json.loads(args.catalog.read_text()), args.out)


if __name__ == '__main__':
    main()
