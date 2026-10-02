"""Aggregate only: hit metrics, paired sign tests and deterministic bootstrap CI."""
import argparse
import json
import math
import random
import statistics
import unicodedata
from collections import Counter
from pathlib import Path
from privacy import private_output
from queries import load


def normal(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold() if c.isalnum())


def quantile(values, fraction):
    values = sorted(values)
    return values[max(0, math.ceil(len(values)*fraction)-1)]


def measure(query, record):
    payload = record['payload'] or {}
    results = payload.get('results', [])
    episodes = [r['episode_ref'] for r in results]
    gold = set(query['gold_episode_ids'])
    ranks = [i+1 for i,e in enumerate(episodes) if e in gold]
    rank = min(ranks, default=0)
    strings = []
    def collect(value):
        if isinstance(value, str):
            strings.append(value)
        elif isinstance(value, list):
            for v in value:
                collect(v)
        elif isinstance(value, dict):
            for v in value.values():
                collect(v)
    collect(results)
    answer = normal(query['expected_answer'])
    return {**record, 'group':query['group'], 'style':query['style'], 'rank':rank,
            'ranked_episode_ids':episodes, 'gold_ranks':{e:(episodes.index(e)+1 if e in episodes else None) for e in gold},
            'hit1':int(0<rank<=1), 'hit5':int(0<rank<=5), 'hit10':int(0<rank<=10),
            'mrr':1/rank if rank else 0, 'zero':int(not results),
            'answer':int(bool(answer) and any(answer in normal(s) for s in strings)),
            'graph_only_gold':int(any(r['episode_ref'] in gold and r.get('association_path') and
                               not set(r.get('channels',[])) & {'lexical','alias','vector'} for r in results)),
            'channels_exposed':all('channels' in r for r in results) if results else None,
            'gold_channels': [r.get('channels',[]) for r in results if r['episode_ref'] in gold]}


def aggregate(rows):
    result = {'n':len(rows)}
    for key in ['hit1','hit5','hit10','mrr','zero','answer']:
        result[key] = statistics.mean(r[key] for r in rows)
    result.update({'median_ms':statistics.median(r['wall_ms'] for r in rows),
                   'p95_ms':quantile([r['wall_ms'] for r in rows],.95),
                   'median_bytes':statistics.median(r['bytes'] for r in rows),
                   'max_bytes':max(r['bytes'] for r in rows),
                   'errors':sum(bool(r['error']) or (r['payload'] or {}).get('ok') is False for r in rows),
                   'vector_lane':dict(Counter(r['vector_lane']['state'] for r in rows)),
                   'vector_coverage':dict(Counter((r['payload'] or {}).get('coverage',{}).get('vectors',{}).get('state','missing') for r in rows)),
                   'channels_exposed':any(r['channels_exposed'] for r in rows),
                   'vector_coverage_codes':dict(Counter(code for r in rows for code in
                       (r['payload'] or {}).get('coverage',{}).get('vectors',{}).get('codes',[]))),
                   'vague_graph_only_gold':sum(r['graph_only_gold'] for r in rows if r['style']=='vague')})
    return result


def paired(a, b):
    assert a.keys() == b.keys()
    output = {}
    rng = random.Random(20261002)
    for metric in ['hit5', 'mrr']:
        differences = [a[k][metric]-b[k][metric] for k in sorted(a)]
        wins = sum(d>0 for d in differences)
        losses = sum(d<0 for d in differences)
        n = wins+losses
        p = min(1.0, 2*sum(math.comb(n,i) for i in range(min(wins,losses)+1))/2**n) if n else 1.0
        draws = sorted(statistics.mean(rng.choices(differences,k=len(differences))) for _ in range(10000))
        output[metric] = {'wins':wins,'losses':losses,'ties':len(differences)-n,'difference':statistics.mean(differences),
                          'sign_test_p':p,'bootstrap_ci95':[draws[249],draws[9749]]}
    output['a_only_gold_any_rank'] = sum(a[k]['rank']>0 and b[k]['rank']==0 for k in a)
    output['a_only_vector_supported_gold'] = sum(a[k]['rank']>0 and b[k]['rank']==0 and
        any('vector' in channels for channels in a[k]['gold_channels']) for k in a)
    output['b_only_gold_any_rank'] = sum(b[k]['rank']>0 and a[k]['rank']==0 for k in a)
    return output


def table(entries):
    text = '| Arm / slice | n | H@1 | H@5 | H@10 | MRR | Empty | Answer | ms med / p95 | bytes med / max |\n'
    text += '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n'
    for label, r in entries:
        text += f"| {label} | {r['n']} | " + ' | '.join(f"{100*r[k]:.1f}%" for k in ['hit1','hit5','hit10'])
        text += f" | {r['mrr']:.3f} | {100*r['zero']:.1f}% | {100*r['answer']:.1f}% | {r['median_ms']:.1f} / {r['p95_ms']:.1f} | {r['median_bytes']:.0f} / {r['max_bytes']} |\n"
    return text


def read_keep(path):
    text = path.read_text().strip()
    if text.startswith('['):
        rows = json.loads(text)
    else:
        rows = [json.loads(line) if line.startswith(('{', '"')) else line
                for line in map(str.strip, text.splitlines()) if line]
    return {r['query_id'] if isinstance(r, dict) else r for r in rows}


def read_judgments(path):
    result = {}
    for row in load(path):
        key = (row['query_id'],row['arm'])
        assert key not in result, 'duplicate answer judgment'
        assert isinstance(row['answer_present'], bool), 'answer_present must be boolean'
        result[key] = row['answer_present']
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--keep-queries', type=Path, help='JSON array, JSONL query_id rows, or one ID per line')
    parser.add_argument('--answer-judgments', type=Path, help='JSONL query_id, arm, answer_present boolean')
    args = parser.parse_args()
    args.out = private_output(args.out)
    queries = {r['id']:r for r in load(args.out/'queries.jsonl')}
    records = load(args.out/'results.jsonl')
    assert len(records)==4*len(queries)
    assert len({(r['id'],r['arm']) for r in records})==len(records)
    assert all({r['arm'] for r in records if r['id']==key}=={'A1','B1','A2','B2'} for key in queries)
    if args.keep_queries:
        keep = read_keep(args.keep_queries)
        assert keep <= queries.keys(), 'unknown keep query IDs'
        queries = {k:v for k,v in queries.items() if k in keep}
    assert queries, 'no retained queries'
    judgments = read_judgments(args.answer_judgments) if args.answer_judgments else {}
    assert set(judgments) <= {(r['id'],r['arm']) for r in records}, 'unknown judgment IDs/arms'
    rows = [measure(queries[r['id']],r) for r in records if r['id'] in queries]
    for row in rows:
        key = (row['id'],row['arm'])
        if key in judgments:
            row['answer'] = int(judgments[key])
    # Keep filtered summaries separate from the canonical unfiltered measurement.
    suffix = '-filtered' if args.keep_queries or args.answer_judgments else ''
    (args.out/f'measured{suffix}.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
    aggregate_rows = {}
    report = []
    for dimension, slices in [('overall',[None]),('group',['DAILY','JEV','SANDY']),('style',['vague','paraphrase','keyword'])]:
        entries = []
        for value in slices:
            for arm in ['A1','B1','A2','B2']:
                chosen = [r for r in rows if r['arm']==arm and (value is None or r[dimension]==value)]
                if chosen:
                    label = arm if value is None else arm+'/'+value
                    aggregate_rows[label] = aggregate(chosen)
                    entries.append((label,aggregate_rows[label]))
        report.append(table(entries))
    arms = {arm:{r['id']:r for r in rows if r['arm']==arm} for arm in ['A1','B1','A2','B2']}
    comparisons = {a+'-'+b:paired(arms[a],arms[b]) for a,b in [('A1','B1'),('A2','B2'),('B2','A1')]}
    slice_comparisons = {}
    for dimension, values in [('group',['DAILY','JEV','SANDY']),('style',['vague','paraphrase','keyword'])]:
        for value in values:
            selected = {arm:{k:r for k,r in records.items() if r[dimension]==value} for arm,records in arms.items()}
            if selected['A1']:
                slice_comparisons[value] = {a+'-'+b:paired(selected[a],selected[b]) for a,b in [('A1','B1'),('A2','B2'),('B2','A1')]}
    summary = {'paired_slices':slice_comparisons, 'metrics':aggregate_rows,'paired':comparisons,'query_counts':dict(Counter(r['group']+'/'+r['style'] for r in queries.values()))}
    (args.out/f'aggregate{suffix}.json').write_text(json.dumps(summary,indent=2))
    (args.out/f'aggregate-tables{suffix}.md').write_text('\n'.join(report))
    print('\n'.join(report))
    graph = {arm: aggregate_rows[arm]['vague_graph_only_gold']
             if aggregate_rows[arm]['channels_exposed'] else 'result does not expose channels'
             for arm in arms}
    print(json.dumps({'paired': comparisons, 'query_counts': summary['query_counts'],
                      'vague_graph_expansion_only_gold_hits': graph}, indent=2))


if __name__ == '__main__':
    main()
