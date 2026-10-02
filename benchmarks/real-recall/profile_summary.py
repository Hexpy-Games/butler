"""Summarize inclusive probes into disjoint stages and private SQL query plans."""
import argparse
import collections
import json
import re
import sqlite3
import statistics
from pathlib import Path
from privacy import private_output
from profile_bytes import summary

STAGES = {
    'arguments_binding': ['arguments_parse', 'cognition/memory_recall/tool.rs::prepare',
                          'cognition/memory_recall/validate.rs::normalize'],
    'generation': ['cognition/generation/read.rs::resolve_active_generation'],
    'vector': ['cognition/memory_recall/service.rs::vector_facts'],
    'vector_validation': ['cognition/graph/recall.rs::current_vector_matches'],
    'open_sources': ['cognition/memory_recall/query.rs::open_sources'],
    'raw_bm25': ['cognition/graph/recall/raw.rs::select'],
    'inventory': ['cognition/sources/inventory.rs::read_canonical_inventory'],
    'coverage': ['cognition/graph/recall.rs::projection_coverage'],
    'alias': ['cognition/graph/recall/semantic/aliases.rs::select'],
    'lexical': ['cognition/graph/recall/semantic/lexical.rs::select'],
    'expansion': ['cognition/memory_recall/selection/seeds.rs::expand'],
    'ranking': ['cognition/memory_recall/selection/rank.rs::rank'],
    'evidence_binding_hydration': ['cognition/memory_recall/binding.rs::run'],
    'packing': ['cognition/memory_recall/response.rs::initial',
                'cognition/memory_recall/service.rs::encode'],
}


def normalize_sql(sql):
    sql = re.sub(r"'(?:[^']|'')*'", '?', sql)
    sql = re.sub(r'\b\d+(?:\.\d+)?\b', '?', sql)
    return ' '.join(sql.split())


def sql_category(kind, family):
    if kind == 'turn':
        if 'conversation_parts' in family:
            return 'canonical_parts'
        if 'conversation_turn_outcomes' in family:
            return 'canonical_inventory'
        return 'canonical_point_reads'
    if 'memory_aliases' in family and 'SELECT COUNT' in family:
        return 'lexical_size'
    for table, stage in [('memory_alias_postings', 'lexical'),
                         ('memory_vector_units', 'vector_validation'),
                         ('memory_source_terms', 'raw_bm25'),
                         ('memory_source_text', 'raw_bm25'),
                         ('JOIN edges', 'expansion_or_binding'),
                         ('memory_claim', 'claims_or_binding'),
                         ('memory_chunk_sources', 'sources_or_ranking'),
                         ('memory_aliases', 'alias'),
                         ('memory_projection_jobs', 'coverage')]:
        if table in family:
            return stage
    return 'other_graph'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--copy', type=Path, required=True)
    parser.add_argument('--sql', action='store_true')
    parser.add_argument('--warm-start', type=int, default=0)
    args = parser.parse_args()
    out = private_output(args.out)
    groups = {}
    sql_groups = collections.defaultdict(list)
    all_functions = collections.defaultdict(list)
    function_calls = collections.defaultdict(list)
    function_first = collections.defaultdict(list)
    for mode in ['warm', 'cold']:
        runs = []
        raw_rows = []
        start = args.warm_start if mode=='warm' else 0
        for repeat in range(start, start+3):
            path = out/f'{mode}-{repeat}.jsonl'
            if not path.exists():
                continue
            rows = []
            for line in path.read_text().splitlines():
                row = json.loads(line)
                raw_rows.append({'profile_memory': row['profile_memory'], 'vector_lane': row['vector_lane']})
                durations = collections.defaultdict(float)
                generation_calls = []
                for label, duration, count, first in row['profile_memory']+row['profile_turn']:
                    durations[label] += duration
                    function_calls[(mode, label)].append(count)
                    function_first[(mode, label)].append(first)
                    if label == 'cognition/generation/read.rs::resolve_active_generation':
                        generation_calls.append(first)
                stages = {stage: sum(durations[label] for label in labels)
                          for stage, labels in STAGES.items()}
                # prepare also resolves the generation; attribute that nested probe
                # to generation, not twice to both generation and binding.
                if generation_calls:
                    stages['arguments_binding'] -= generation_calls[0]
                stages['other_seeds'] = (durations['cognition/graph/recall.rs::semantic_seeds']
                    - stages['alias'] - stages['lexical']
                    + durations['cognition/graph/recall.rs::temporal_seeds'])
                stages['other'] = row['wall_ms']-sum(stages.values())
                assert stages['other'] >= -1, stages
                rows.append({'wall_ms': row['wall_ms'], 'stages': stages,
                             'vector': row['vector_lane'], 'payload': row['payload'],
                             'gold_ranks': row['gold_ranks'], 'error': row['error'],
                             'bytes': row['bytes']})
                for label, duration in durations.items():
                    all_functions[(mode, label)].append(duration)
                if mode=='warm':
                    for kind in ['memory', 'turn']:
                        for sql, ms, scan, vm in row['sql_'+kind]:
                            sql_groups[(kind, normalize_sql(sql))].append((sql, ms, scan, vm))
            runs.append(rows)
            assert len(rows) == 175, (mode, repeat, len(rows))
        if not runs:
            continue
        rows = [row for run in runs for row in run]
        result = {'n': len(rows), 'wall_ms': summary([r['wall_ms'] for r in rows]),
                  'run_medians_ms': [statistics.median(r['wall_ms'] for r in run) for run in runs],
                  'stages': {}, 'vector_states': dict(collections.Counter(r['vector']['state'] for r in rows)),
                  'explicit_lane_deadline': sum(any(event[0]=='vector_lane_deadline' for event in r['profile_memory']) for r in raw_rows),
                  'vector_unavailable': sum(r['payload']['coverage']['vectors']['state']=='unavailable' for r in rows),
                  'diagnostic_codes': dict(collections.Counter(c for r in rows for lane in r['payload']['coverage'].values() for c in lane['codes']))}
        result['empty_responses'] = sum(not r['payload']['results'] for r in rows)
        result['tool_errors'] = sum(r['error'] is not None for r in rows)
        result['byte_budget_failures'] = sum(r['bytes'] > 24576 for r in rows)
        result['status_counts'] = dict(collections.Counter(r['payload']['status'] for r in rows))
        result['gold_hit_at_5_percent'] = 100*statistics.mean(
            any(rank is not None and rank <= 5 for rank in r['gold_ranks'].values()) for r in rows)
        nonempty = [r['wall_ms'] for r in rows if r['payload']['results']]
        result['nonempty_wall_ms'] = summary(nonempty) if nonempty else None
        result['embedding_timeout'] = sum(r['vector']['state'] == 'timed_out' for r in rows)
        result['any_vector_deadline'] = sum(
            r['vector_lane']['state'] == 'timed_out'
            or any(event[0] == 'vector_lane_deadline' for event in r['profile_memory'])
            for r in raw_rows)
        result['embedding_ms'] = summary([r['vector'].get('wall_ms', 0) for r in rows])
        result['result_counts'] = summary([len(r['payload']['results']) for r in rows])
        result['response_bytes'] = summary([r['bytes'] for r in rows])
        result['per_run_empty'] = [sum(not r['payload']['results'] for r in run) for run in runs]
        for stage in rows[0]['stages']:
            result['stages'][stage] = {
                'ms': summary([r['stages'][stage] for r in rows]),
                'share_percent': summary([100*r['stages'][stage]/r['wall_ms'] for r in rows]),
                'run_medians_ms': [statistics.median(r['stages'][stage] for r in run) for run in runs]}
        groups[mode] = result
    groups['functions'] = {mode: {label: {'n': len(values), **summary(values)} for (m, label), values in all_functions.items() if m==mode}
                           for mode in ['warm', 'cold']}
    groups['function_calls'] = {mode: {label: summary(values) for (m, label), values in function_calls.items() if m==mode}
                               for mode in ['warm', 'cold']}
    groups['function_first_ms'] = {mode: {label: summary(values) for (m, label), values in function_first.items() if m==mode}
                                  for mode in ['warm', 'cold']}
    (out/'time-summary.json').write_text(json.dumps(groups, indent=2))
    if args.sql:
        graph = next(args.copy.glob('cognition/memory/generations/*/graph.sqlite'))
        connections = {kind: sqlite3.connect(f'file:{path}?immutable=1', uri=True)
                       for kind, path in [('memory', graph), ('turn', args.copy/'runtime/conversation-store.sqlite')]}
        plans = []
        # Per-family cumulative SQL cost; repeated audit point reads matter too.
        ordered = sorted(
            ((key, samples) for key, samples in sql_groups.items()
             if key[1].upper().startswith(('SELECT', 'WITH'))),
            key=lambda item: -sum(s[1] for s in item[1]))
        selected = list(ordered[:30])
        categories = collections.Counter()
        for key, samples in ordered:
            category = sql_category(*key)
            if categories[category] < 2:
                if (key, samples) not in selected:
                    selected.append((key, samples))
                categories[category] += 1
        for (kind, family), samples in selected:
            sql, _, _, _ = max(samples, key=lambda sample: sample[1])
            if not sql.lstrip().upper().startswith(('SELECT', 'WITH')):
                continue
            db = connections[kind]
            plan = [row[3] for row in db.execute('EXPLAIN QUERY PLAN '+sql)]
            row_count = sum(1 for _ in db.execute(sql))
            plans.append({'kind': kind, 'sql_family': family, 'example_sql': sql,
                          'category': sql_category(kind, family),
                          'observed_calls_nonzero_ms': len(samples),
                          'total_observed_ms': sum(s[1] for s in samples),
                          'duration_ms': summary([s[1] for s in samples]),
                          'fullscan_steps': summary([s[2] for s in samples]),
                          'vm_steps': summary([s[3] for s in samples]),
                          'returned_rows_example': row_count, 'plan': plan})
        db = connections['memory']
        sizes = list(db.execute('SELECT name,sum(pgsize) FROM dbstat GROUP BY name ORDER BY sum(pgsize) DESC'))
        counts = {table: db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                  for table, in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%' AND name NOT LIKE '%fts%' ")}
        for db in connections.values():
            db.close()
        (out/'sql-plans.json').write_text(json.dumps({'plans': plans, 'sizes': sizes, 'row_counts': counts}, indent=2))
        for kind in ['memory', 'turn']:
            requests = [{'label': f'{kind}-family-{index}', 'sql': row['example_sql']}
                        for index, row in enumerate(plans) if row['kind'] == kind]
            (out/f'sql-replay-{kind}.json').write_text(json.dumps(requests, indent=2))
    print(json.dumps({mode: groups[mode] for mode in ['warm', 'cold'] if mode in groups}, indent=2))


if __name__ == '__main__':
    main()
