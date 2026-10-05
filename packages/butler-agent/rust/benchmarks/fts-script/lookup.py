"""Index-only timing with complete unlimited-query reference assertions."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import statistics
import sys
import time
from analyzer import expression


def run(output, artifacts):
    spec = importlib.util.spec_from_file_location('neutral', Path(__file__).parents[1]/'fts-tune/offline.py')
    neutral = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(neutral)
    qs = json.loads((artifacts/'questions.json').read_text())
    split = json.loads((artifacts/'protocol.json').read_text())['split']
    result = {}
    sql = ('SELECT m.episode_id FROM memory_episode_fts_v1 f '
           'JOIN memory_episode_fts_meta m ON m.id=f.rowid '
           'JOIN memory_chunks c ON c.memory_chunk_id=m.episode_id AND c.current_revision=m.revision '
           "WHERE memory_episode_fts_v1 MATCH ? AND c.status='active' "
           'AND (? IS NULL OR m.project_id=?) '
           'ORDER BY bm25(memory_episode_fts_v1,4,2,1,.25),m.episode_id')
    for name, root in (('baseline', 'data'), ('script', 'script-data')):
        graph = next((output/root).glob('cognition/memory/generations/73*/graph.sqlite'))
        db = sqlite3.connect(f'file:{graph}?mode=ro', uri=True)
        db.execute('PRAGMA query_only=ON')
        assert db.execute('SELECT count(*) FROM memory_episode_fts_meta').fetchone()[0] == 714
        timings = []
        for i, q in sorted(qs.items()):
            if split[i] != 'dev':
                continue
            start = time.perf_counter()
            expr = expression(q['query']) if name == 'script' else ' OR '.join(
                '"'+t+'"' for t in neutral.tokens(q['query'], '2u', query=True))
            project = q['binding']['project_id']
            args = (expr, project, project)
            rows = db.execute(sql+' LIMIT 30', args).fetchall() if expr else []
            timings.append((time.perf_counter()-start)*1000)
            assert len(rows) == len(set(rows))
            assert rows == (db.execute(sql, args).fetchall()[:30] if expr else [])
        result[name] = {'median_ms': statistics.median(timings), 'n': len(timings)}
        db.close()
    (output/'dev-lookup.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    run(Path(sys.argv[1]), Path(sys.argv[2]))
