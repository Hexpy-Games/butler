"""Prepare field ablations and summarize generic named benchmark arms privately."""
import argparse
import copy
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from privacy import private_output
from queries import arguments, load
from summarize import aggregate, measure, paired, read_keep


def effective(arguments, vector, query):
    """Canonicalize only documented defaults, for identical-call reuse."""
    args = copy.deepcopy(arguments)
    args.setdefault('seed_phrases', [])
    args.setdefault('vector_queries', [])
    args.setdefault('limit', 6)
    args.setdefault('scope', 'current_project' if query['binding']['project_id'] else 'all_user_sessions')
    args.setdefault('include_vector', True)
    phrases = args['vector_queries']
    valid = isinstance(phrases, list) and len(phrases) <= 4 and all(
        isinstance(phrase, str) and phrase.strip() and len(phrase) <= 2048 for phrase in phrases)
    if not vector and valid:
        # Valid query phrases cannot affect retrieval without an adapter.
        # Keep invalid values so argument-validation failures remain observable.
        args['vector_queries'] = []
    return json.dumps([vector, args], sort_keys=True, ensure_ascii=False)


def prepare(queries, out):
    fields = sorted({field for query in queries for field in query['model_args']})
    mapping = {}
    prepared = []
    for query in queries:
        raw = {'cue': query['query']}
        model = query['model_args']
        variants = []
        reused = {}
        names = {}
        for lane, vector in [('A', True), ('B', False)]:
            choices = [(lane+'1', raw), (lane+'2', model)]
            for field in fields:
                only = copy.deepcopy(raw)
                if field in model:
                    only[field] = model[field]
                reset = copy.deepcopy(model)
                if field == 'cue':
                    reset[field] = raw[field]
                else:
                    reset.pop(field, None)
                choices += [(f'{lane}+{field}', only), (f'{lane}-{field}', reset)]
            for name, arguments in choices:
                key = effective(arguments, vector, query)
                if key not in reused:
                    reused[key] = name
                    variants.append({'name': name, 'vector': vector, 'arguments': arguments})
                names[name] = reused[key]
        mapping[query['id']] = names
        prepared.append({**query, 'arms': variants})
    (out/'ablation-queries.jsonl').write_text(''.join(json.dumps(q, ensure_ascii=False)+'\n' for q in prepared))
    (out/'ablation-map.json').write_text(json.dumps(mapping))
    categories = {}
    for field in fields:
        values = [q['model_args'][field] for q in queries if field in q['model_args']]
        categories[field] = dict(Counter(
            f'items={len(value)}' if isinstance(value, list) else
            f'characters={len(value)}' if field == 'cue' else str(value) for value in values))
    (out/'argument-categories.json').write_text(json.dumps(categories, indent=2))
    print(f'{len(queries)} queries; {sum(len(q["arms"]) for q in prepared)} unique calls; fields={fields}')


def summarize(queries, results, out, keep, mapping, reference=None):
    assert keep <= {q['id'] for q in queries}, 'unknown keep query IDs'
    queries = {q['id']: q for q in queries if q['id'] in keep}
    assert queries, 'no retained queries'
    arms = {}
    for record in results:
        if record['id'] not in queries:
            continue
        row = measure(queries[record['id']], record)
        names = mapping[record['id']] if mapping else {record['arm']: record['arm']}
        for name, source in names.items():
            if source == record['arm']:
                arm = arms.setdefault(name, {})
                assert record['id'] not in arm, 'duplicate record'
                arm[record['id']] = {**row, 'arm': name}
    assert arms and all(set(rows) == set(queries) for rows in arms.values()), 'incomplete arm'
    reference_arms = {}
    for record in reference or []:
        if record['id'] in queries and record['arm'] in ['A1', 'B1', 'A2', 'B2']:
            reference_arms.setdefault(record['arm'], {})[record['id']] = measure(queries[record['id']], record)
    assert all(set(rows) == set(queries) for rows in reference_arms.values()), 'incomplete reference'
    current = dict(arms)
    for name, rows in reference_arms.items():
        arms.setdefault(name, rows)
    metrics = {name: aggregate(list(rows.values())) for name, rows in arms.items()}
    comparisons = {}
    for name in arms:
        base = name[0]+'1' if '+' in name else name[0]+'2'
        if name != base:
            comparisons[name+' vs '+base] = paired(arms[name], arms[base])
    for lane in ['A', 'B']:
        if lane+'1' in arms and lane+'2' in arms:
            comparisons[lane+'2 vs '+lane+'1'] = paired(arms[lane+'2'], arms[lane+'1'])
    before_after = {name: paired(rows, reference_arms[name]) for name, rows in current.items()
                    if name in reference_arms}
    references = {name: aggregate(list(rows.values())) for name, rows in reference_arms.items()}
    (out/'analysis.json').write_text(json.dumps({'metrics': metrics, 'paired': comparisons,
        'before_after': before_after, 'reference_metrics': references}, indent=2))
    lines = ['| Arm | n | Hit@5 | MRR | Δ hit@5 pp | Δ MRR |', '|---|---:|---:|---:|---:|---:|']
    for name in sorted(metrics):
        row = metrics[name]
        comparison = comparisons.get(name+' vs '+(name[0]+'1' if '+' in name else name[0]+'2'))
        delta = f'{100*comparison["hit5"]["difference"]:+.2f} | {comparison["mrr"]["difference"]:+.4f}' if comparison else '— | —'
        lines.append(f'| {name} | {row["n"]} | {100*row["hit5"]:.2f}% | {row["mrr"]:.4f} | {delta} |')
    (out/'analysis.md').write_text('\n'.join(lines)+'\n')
    print('\n'.join(lines))


def regenerate(queries, schema_path, out):
    """Keep questions and bindings fixed; expose only schema/questions to Luna."""
    schema = json.loads(schema_path.read_text())
    batches = [queries[start:start+25] for start in range(0, len(queries), 25)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        outputs = pool.map(lambda item: arguments(item, out, schema), enumerate(batches))
        by_id = {row['id']: row['args'] for batch in outputs for row in batch}
    allowed = set(schema['parameters']['properties'])
    rows = []
    for query in queries:
        args = by_id[query['id']]
        assert isinstance(args.get('cue'), str) and set(args) <= allowed
        rows.append({**query, 'model_args': args})
    (out/'regenerated-queries.jsonl').write_text(''.join(json.dumps(q, ensure_ascii=False)+'\n' for q in rows))
    print(f'Regenerated arguments for {len(rows)} fixed questions using gpt-6-luna')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--queries', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--results', type=Path)
    parser.add_argument('--keep-queries', type=Path)
    parser.add_argument('--mapping', type=Path)
    parser.add_argument('--reference-results', type=Path, help='four-arm controls for before/after comparisons')
    parser.add_argument('--schema', type=Path, help='regenerate arguments only; do not regenerate questions')
    args = parser.parse_args()
    out = private_output(args.out)
    out.mkdir(parents=True, exist_ok=True)
    queries = load(args.queries)
    if args.schema:
        regenerate(queries, args.schema, out)
    elif args.results:
        keep = read_keep(args.keep_queries) if args.keep_queries else {q['id'] for q in queries}
        mapping = json.loads(args.mapping.read_text()) if args.mapping else None
        reference = load(args.reference_results) if args.reference_results else None
        summarize(queries, load(args.results), out, keep, mapping, reference)
    else:
        prepare(queries, out)


if __name__ == '__main__':
    main()
