"""Sequential three-repeat A1 profiles, with best-effort COPY-only cache advice."""
import argparse
import json
import os
import subprocess
import sys
from tempfile import TemporaryDirectory
from pathlib import Path
from privacy import private_output


def evict(copy):
    files = size = 0
    for path in copy.rglob('*'):
        if path.is_file():
            with path.open('rb') as stream:
                os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
            files += 1
            size += path.stat().st_size
    return {'files': files, 'bytes_advised': size,
            'method': 'POSIX_FADV_DONTNEED on sealed copy; eviction not guaranteed'}


def validate(path, quality_failures=None):
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    for row in rows:
        assert row['error'] is None
        payload = row['payload']
        ids = [result['episode_ref'] for result in payload['results']]
        assert ids == row['ranked_episode_ids']
        assert len(ids) == len(set(ids)) and len(ids) <= 6
        assert payload['ok']
        # JSON byte checks in verify.py use Rust-compatible number formatting;
        # ordinary Python encoding suffices on this corpus and is checked here.
        assert len(json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()) == row['bytes']
        try:
            assert row['bytes'] <= 24576, 'serialized response exceeds 24 KiB'
        except AssertionError:
            if quality_failures is None:
                raise
            quality_failures.append({'query_id': row['query_id'], 'wall_ms': row['wall_ms'],
                                     'reason': 'byte budget exceeded', 'bytes': row['bytes']})
        for gold, rank in row['gold_ranks'].items():
            assert rank == (ids.index(gold)+1 if gold in ids else None)
        assert row['profile_memory'] and row['profile_turn']
        try:
            assert payload['results'], 'expected nonempty recall on kept population'
        except AssertionError:
            if quality_failures is None:
                raise
            quality_failures.append({'query_id': row['query_id'], 'wall_ms': row['wall_ms'],
                                     'reason': 'empty response', 'status': payload['status']})
    return rows


def invoke(args, query, output, log, cold=False):
    with TemporaryDirectory(prefix='recall-isolation-', dir=args.copy.parent) as temporary:
        root = Path(temporary)
        (root/'home').mkdir()
        (root/'data').mkdir()
        environment = dict(os.environ, HOME=str(root/'home'), BUTLER_DATA=str(root/'data'))
        if cold:
            environment['RECALL_PROFILE_COLD'] = '1'
        subprocess.run([args.binary, args.copy, query, output], env=environment,
                       stdout=log, stderr=log, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--copy', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--mode', choices=['warm', 'cold'], required=True)
    parser.add_argument('--start-repeat', type=int, default=0)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--resume', action='store_true', help='retain completed cold samples; never rerun them')
    args = parser.parse_args()
    out = private_output(args.out)
    if args.mode == 'cold':
        queries = sorted(out.glob('cold-query-*.jsonl'))
        assert len(queries) == 175
    quality_failures = []
    for repeat in range(args.start_repeat, args.start_repeat+args.repeats):
        log = (out/f'{args.mode}-{repeat}.log').open('a' if args.resume else 'w')
        if args.mode == 'warm':
            path = out/f'warm-{repeat}.jsonl'
            assert not path.exists(), 'refusing to overwrite measurements'
            invoke(args, out/'a1-queries.jsonl', path, log)
            assert len(validate(path, quality_failures)) == 175
        else:
            aggregate = out/f'cold-{repeat}.jsonl'
            assert not aggregate.exists() or args.resume, 'refusing to overwrite measurements'
            completed = len(aggregate.read_text().splitlines()) if aggregate.exists() else 0
            if completed:
                validate(aggregate, quality_failures)
            with aggregate.open('a' if args.resume else 'w') as stream:
                for index, query in enumerate(queries):
                    if index < completed:
                        continue
                    path = out/f'cold-{repeat}-{index:03}.jsonl'
                    advice = {'method': 'retained completed sample; original cache advice unavailable'}
                    if not (args.resume and path.exists()):
                        advice = evict(args.copy)
                        invoke(args, query, path, log, cold=True)
                    rows = validate(path, quality_failures)
                    assert len(rows) == 1
                    rows[0]['cache_advice'] = advice
                    stream.write(json.dumps(rows[0], ensure_ascii=False)+'\n')
                    stream.flush()
                    print(f'cold repeat {repeat+1}, {index+1}/175', flush=True)
        log.close()
        print(f'{args.mode} repeat {repeat+1}: structural checks pass; cumulative quality failures {len(quality_failures)}', flush=True)
    (out/f'{args.mode}-quality-{args.start_repeat}.json').write_text(json.dumps(quality_failures, indent=2))
    if quality_failures:
        print(f'QUALITY CHECK FAILED: {len(quality_failures)} response failures; all planned samples retained', flush=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
