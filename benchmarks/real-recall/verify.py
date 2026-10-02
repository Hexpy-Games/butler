"""Validate measurement completeness and metric arithmetic on synthetic data."""
import argparse
import json
from collections import Counter
from pathlib import Path
from privacy import private_output
from queries import load
from summarize import measure, paired, normal, read_keep, read_judgments
from tempfile import TemporaryDirectory


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--queries', type=Path)
    parser.add_argument('--results', type=Path)
    args = parser.parse_args()
    args.out = private_output(args.out)
    queries = {r['id']:r for r in load(args.queries or args.out/'queries.jsonl')}
    rows = load(args.results or args.out/'results.jsonl')
    expected = {key: Counter(arm['name'] for arm in query['arms'])
                if 'arms' in query else Counter({'A1':1,'B1':1,'A2':1,'B2':1})
                for key, query in queries.items()}
    assert queries and all(expected.values()), 'empty queries or arm set'
    assert all(count == 1 for arms in expected.values() for count in arms.values())
    assert Counter(r['id'] for r in rows) == Counter({k:sum(v.values()) for k,v in expected.items()})
    assert all(Counter(r['arm'] for r in rows if r['id']==key)==arms for key,arms in expected.items())
    for row in rows:
        assert row['query_id'] == row['id']
        assert len(row['payload_text']) <= 6000
        measured = measure(queries[row['id']],row)
        assert measured['ranked_episode_ids'] == row['ranked_episode_ids']
        assert measured['gold_ranks'] == row['gold_ranks']
        payload = row['payload']
        if payload is not None:
            # Rust serde uses compact UTF-8. Ensure no transport truncation.
            assert row['bytes']==len(json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode())
            if payload.get('ok'):
                ids = [r['episode_ref'] for r in payload['results']]
                assert len(ids)==len(set(ids))
                assert payload['status'] in ('complete','partial','unavailable')
        query = queries[row['id']]
        vector = next((arm['vector'] for arm in query.get('arms', []) if arm['name']==row['arm']),
                      row['arm'].startswith('A'))
        if not vector:
            assert row['vector_lane']['state']=='unavailable'
    # test-category: pure-logic
    q = {'gold_episode_ids':['gold'],'expected_answer':'Ａ b','group':'DAILY','style':'vague'}
    r = {'payload':{'results':[{'episode_ref':'other'},{'episode_ref':'gold','summary':'a B','channels':['graph'],
                               'association_path':[{'edge':'test'}]}]},'vector_lane':{'state':'not_attempted'},'wall_ms':1,'bytes':1,'error':None}
    m = measure(q,r)
    assert (m['rank'],m['hit1'],m['hit5'],m['hit10'],m['mrr'],m['answer'],m['graph_only_gold'])==(2,0,1,1,.5,1,1)
    assert normal('Ａ B')=='ab'
    comparison = paired({'1':m},{'1':{**m,'hit5':0,'mrr':0,'rank':0}})
    assert comparison['hit5']['wins']==1 and comparison['hit5']['sign_test_p']==1
    assert comparison['hit5']['bootstrap_ci95']==[1,1]
    with TemporaryDirectory() as temporary:
        directory = Path(temporary)
        keep = directory/'keep.jsonl'
        keep.write_text(' {"query_id":"one"}\n')
        assert read_keep(keep)=={'one'}
        keep.write_text('["one", "two"]')
        assert read_keep(keep)=={'one','two'}
        keep.write_text('one\ntwo\n')
        assert read_keep(keep)=={'one','two'}
        judgments = directory/'judgments.jsonl'
        judgments.write_text('{"query_id":"one","arm":"A1","answer_present":false}\n')
        assert read_judgments(judgments)=={('one','A1'):False}
    print(f'validated {len(queries)} questions, {len(rows)} complete arm records; metric arithmetic passed')


if __name__=='__main__':
    main()
