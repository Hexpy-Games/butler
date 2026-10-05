"""Run held-out four-arm comparison only after the dev selection is frozen.

Use native baseline/script traces, plus the recall-judge benchmark's saved A1
vector trace. The latter is a saved-build control, not a same-build vector run.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
from judge import load_traces, run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifacts', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    assert not output.is_relative_to(Path(__file__).resolve().parents[6])
    freeze = (output/'freeze.json').read_bytes()
    winner = json.loads(freeze)['winner']
    questions = json.loads((args.artifacts/'questions.json').read_text())
    split = json.loads((args.artifacts/'protocol.json').read_text())['split']
    held = {i for i in questions if split[i] == 'heldout'}
    graph = next((output/'data').glob('cognition/memory/generations/73*/graph.sqlite'))
    db = sqlite3.connect(f'file:{graph}?mode=ro', uri=True)
    summaries = {hashlib.sha256(e.encode()).hexdigest(): s or ''
                 for e, s in db.execute('SELECT memory_chunk_id,summary FROM memory_chunks')}
    db.close()
    vector = {r['id']: r for r in map(json.loads,
              (args.artifacts.parent/'vague/all-baseline-results.jsonl').open())
              if r['arm'] == 'A1' and r['id'] in held}
    traces = {name: load_traces(output/(name+'-heldout-valid.jsonl'))
              for name in ('baseline', 'script')}
    assert all(set(rows) == held and all(r['payload']['ok'] for r in rows.values())
               for rows in traces.values())
    assert set(vector) == held
    for name, rows, count in [('baseline15', traces['baseline'], 15),
                               ('script15', traces['script'], 15),
                               (winner+'30', traces[winner], 30), ('vectors15', vector, 15)]:
        assert (output/'freeze.json').read_bytes() == freeze
        run(output/name, questions, rows, summaries, count)
    assert (output/'freeze.json').read_bytes() == freeze


if __name__ == '__main__':
    main()
