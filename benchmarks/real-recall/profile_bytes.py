"""Offline byte attribution and explicitly unjudged presentation counterfactuals."""
import argparse
import copy
import json
import math
import statistics
import unicodedata
from pathlib import Path
from privacy import private_output


def load(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFKC', value).casefold() if c.isalnum())


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def answer_present(payload, answer):
    needle = normalized(answer)
    return bool(needle) and any(needle in normalized(s) for s in strings(payload['results']))


def summary(values):
    ordered = sorted(values)
    return {'median': statistics.median(values),
            'p95': ordered[math.ceil(.95*len(values))-1],
            'min': ordered[0], 'max': ordered[-1]}


def breakdown(payload):
    # Attribute actual field serializations; residual contains all object/array
    # delimiters and separators, allowing an exact additive reconciliation.
    groups = dict(ranked=0, excerpts=0, evidence_metadata=0, graph_claim=0,
                  cursor=0, metadata=0)
    def field(key, value):
        return len(encoded(key))+1+len(encoded(value))
    for key, value in payload.items():
        if key != 'results':
            groups['cursor' if key == 'next_cursor' else 'metadata'] += field(key, value)
    detail = {'matched_node_ref', 'association_path', 'requirements', 'interpretations',
              'current_state_requires_verification', 'qualifications'}
    for result in payload['results']:
        for key, value in result.items():
            if key == 'evidence':
                for evidence in value:
                    for name, child in evidence.items():
                        groups['excerpts' if name == 'excerpt' else 'evidence_metadata'] += field(name, child)
            else:
                groups['graph_claim' if key in detail else 'ranked'] += field(key, value)
    groups['structure'] = len(encoded(payload))-sum(groups.values())
    assert groups['structure'] >= 0
    return groups


def cap_excerpts(payload, budget):
    """Hypothetical UTF-8 prefix budget across all excerpts of EACH result."""
    payload = copy.deepcopy(payload)
    for result in payload['results']:
        remaining = budget
        for evidence in result['evidence']:
            value = evidence['excerpt'].encode()[:remaining].decode('utf-8', errors='ignore')
            evidence['excerpt'] = value
            remaining -= len(value.encode())
    return payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = private_output(args.out)
    queries = {q['query_id']: q for q in load(args.input/'queries.jsonl')}
    keep = {q['query_id'] for q in load(args.input/'keep.jsonl')}
    judgments = {(q['query_id'], q['arm']): q['answer_present'] for q in load(args.input/'judgments.jsonl')}
    records = [r for r in load(args.input/'results.jsonl') if r['query_id'] in keep and r['arm']=='A1']
    assert len(records) == len(keep) == 175
    parts = [breakdown(r['payload']) for r in records]
    report = {'n': len(records), 'bytes': summary([r['bytes'] for r in records]),
              'parts': {key: summary([p[key] for p in parts]) for key in parts[0]},
              'parts_mean': {key: statistics.mean(p[key] for p in parts) for key in parts[0]},
              'judged_answer_percent': 100*statistics.mean(judgments[(r['query_id'], 'A1')] for r in records),
              'top_k': [], 'excerpt_caps': []}
    def measure(transform, k):
        samples = []
        for r in records:
            q = queries[r['query_id']]
            p = transform(r['payload'])
            ids = [v['episode_ref'] for v in p['results'][:k]]
            hit = any(v in q['gold_episode_ids'] for v in ids)
            before = answer_present(r['payload'], q['expected_answer'])
            after = answer_present(p, q['expected_answer'])
            # The whole-page external boolean cannot locate supporting evidence.
            samples.append((len(encoded(p)), hit, after, before and not after,
                            judgments[(r['query_id'], 'A1')],
                            p['results'] == r['payload']['results']))
        return {'bytes': summary([s[0] for s in samples]),
                'gold_hit_percent': 100*statistics.mean(s[1] for s in samples),
                'answer_substring_percent': 100*statistics.mean(s[2] for s in samples),
                'substring_lost_count': sum(s[3] for s in samples),
                'external_answer_upper_percent': 100*statistics.mean(s[4] for s in samples),
                'external_answer_lower_percent': 100*statistics.mean(s[4] and s[5] for s in samples)}
    for k in range(1, 7):
        def top(p):
            p = copy.deepcopy(p)
            p['results'] = p['results'][:k]
            return p
        report['top_k'].append({'k': k, **measure(top, k)})
    for budget in [0, 120, 240, 480, 960, 1920, 3840, 7680]:
        report['excerpt_caps'].append({'budget': budget,
            **measure(lambda p: cap_excerpts(p, budget), 5)})
    report['detail_deferrals'] = []
    for fields in [['interpretations'], ['interpretations', 'requirements', 'association_path']]:
        def defer(payload):
            payload = copy.deepcopy(payload)
            for result in payload['results']:
                for field in fields:
                    result.pop(field, None)
            return payload
        report['detail_deferrals'].append({'fields': fields, **measure(defer, 5)})
    all_records = [r for r in load(args.input/'results.jsonl') if r['query_id'] in keep]
    report['graph_fields'] = {k: summary([sum(len(encoded(row.get(k))) for row in r['payload']['results']) for r in records]) for k in ['association_path', 'requirements', 'interpretations', 'matched_node_ref', 'qualifications']}
    report['limits'] = {}
    for arm in ['A1', 'A2']:
        for limit in [5, 6]:
            rows = [r for r in all_records if r['arm']==arm and
                    (6 if arm=='A1' else queries[r['query_id']]['model_args'].get('limit', 6))==limit]
            if rows:
                assert all(len(r['payload']['results']) <= limit for r in rows)
                report['limits'][f'{arm}/{limit}'] = {'n': len(rows),
                    'returned': summary([len(r['payload']['results']) for r in rows]),
                    'bytes': summary([r['bytes'] for r in rows])}
    (out/'bytes-summary.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
