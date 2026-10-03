"""Prepare a per-script projection and query expressions on a disposable copy.

The native probe first backfills the unmodified index. Both arms use the same
complete source fields: assert their neutral tokenization equals native fields.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
from analyzer import expression, tokens


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifacts', type=Path)
    parser.add_argument('copy_graph', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('neutral',
        Path(__file__).parents[1] / 'fts-tune/offline.py')
    neutral = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(neutral)
    docs = json.loads((args.artifacts / 'docs.json').read_text())
    questions = json.loads((args.artifacts / 'questions.json').read_text())
    db = sqlite3.connect(f'file:{args.copy_graph}?mode=ro', uri=True)
    actual = {hashlib.sha256(e.encode()).hexdigest(): (n, rev, *fields)
              for n, e, rev, *fields in db.execute(
                  'SELECT m.id,m.episode_id,m.revision,f.summary,f.entities,f.claims,f.source '
                  'FROM memory_episode_fts_meta m JOIN memory_episode_fts_v1 f ON f.rowid=m.id')}
    assert len(actual) == len(docs) == 714
    rows = []
    for doc in docs:
        n, revision, *fields = actual[doc['id']]
        assert revision == doc['revision']
        for field, saved in zip(neutral.FIELDS, fields):
            assert saved == ' '.join(neutral.tokens(doc[field], '2u')), (n, field)
        rows.append([n, *(' '.join(tokens(doc[field])) for field in neutral.FIELDS)])
    args.output.mkdir(exist_ok=True)
    (args.output / 'script-fields.json').write_text(json.dumps(rows))
    (args.output / 'script-queries.json').write_text(json.dumps(
        {q['query']: expression(q['query']) for q in questions.values()}))
    db.close()
    print(json.dumps({'episodes': len(rows), 'complete_native_fields_verified': True,
                      'questions': len(questions)}))


if __name__ == '__main__':
    main()
