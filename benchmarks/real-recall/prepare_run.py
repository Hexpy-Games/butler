"""Set up synthetic caller bindings on a private copy, then fingerprint all files."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from privacy import private_output
from corpus import read_groups


def fingerprint(root):
    hashes = {}
    for path in sorted(root.rglob('*')):
        if path.is_file():
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                while block := stream.read(1024*1024):
                    digest.update(block)
            hashes[str(path.relative_to(root))] = digest.hexdigest()
    return hashes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--copy', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--seal-existing', action='store_true', help='seal an already prepared private copy')
    args = parser.parse_args()
    args.out = private_output(args.out)
    args.copy = private_output(args.copy)
    if args.copy.resolve() == args.snapshot.resolve():
        raise ValueError('caller setup requires a second copy')
    if args.seal_existing:
        before = json.loads((args.out/'snapshot-fingerprint.json').read_text())
        assert before == fingerprint(args.snapshot), 'snapshot changed before sealing'
        # SQLite read-only WAL readers may maintain shm files. Use rollback
        # journaling on the prepared copy, then deny all filesystem writes.
        for database in args.copy.rglob('*.sqlite'):
            connection = sqlite3.connect(database)
            connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            connection.execute('PRAGMA journal_mode=DELETE')
            connection.close()
        for path in args.copy.rglob('*'):
            path.chmod(0o555 if path.is_dir() else 0o444)
        args.copy.chmod(0o555)
        (args.out/'copy-fingerprint.json').write_text(json.dumps(fingerprint(args.copy),sort_keys=True))
        print('prepared copy sealed read-only; measurement baseline recorded')
        return
    if args.verify:
        for name, root in [('snapshot',args.snapshot),('copy',args.copy)]:
            before = json.loads((args.out/f'{name}-fingerprint.json').read_text())
            after = fingerprint(root)
            assert before == after, f'{name} changed during benchmark'
        print('snapshot and private copy content hashes unchanged during recall')
        return
    bindings = {}
    connection = sqlite3.connect(args.copy/'runtime/conversation-store.sqlite')
    now = '2026-10-02T00:00:00.000Z'
    for project, group in read_groups(args.out/'project-groups.json').items():
        session = 'recall-bench-caller-'+group
        turn = session+'-turn'
        external = session+'-external'
        connection.execute('INSERT INTO conversation_sessions VALUES (?,?,?,?,?,?,?,?)',
                           (session,None,project,'recall-bench',now,now,'active',1))
        connection.execute('INSERT INTO conversation_bindings VALUES (?,?,?,?)',('recall-bench',external,session,now))
        connection.execute('INSERT INTO conversation_turns VALUES (?,?,?,?,?,?,?,?)',
                           (turn,session,1,'user','active',None,now,None))
        bindings[group] = {'session_id':external,'turn_id':turn,'project_id':project}
    connection.commit()
    connection.close()
    (args.out/'caller-bindings.json').write_text(json.dumps(bindings))
    for name, root in [('snapshot',args.snapshot),('copy',args.copy)]:
        (args.out/f'{name}-fingerprint.json').write_text(json.dumps(fingerprint(root),sort_keys=True))
    print('private callers created; snapshot and copy fingerprints recorded')


if __name__ == '__main__':
    main()
