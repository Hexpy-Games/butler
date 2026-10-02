"""SQL-only bounded/resumable shadow-copy experiment; no runtime integration."""

import json
import sqlite3
import time
from pathlib import Path


def batch(db, interrupt=False):
    cursor = json.loads(db.execute("SELECT cursor FROM copy_progress").fetchone()[0])
    rows = db.execute("SELECT node_id,surface_original,source_id FROM memory_aliases "
                      "WHERE (node_id,surface_original,source_id)>(?,?,?) "
                      "ORDER BY node_id,surface_original,source_id LIMIT 128", cursor).fetchall()
    if not rows:
        return False
    with db:
        for node, surface, source in rows:
            db.execute("INSERT OR IGNORE INTO shadow_docs(node_id,source_id,surface_original) VALUES(?,?,?)",
                       (node, source, surface))
            alias_id = db.execute("SELECT id FROM shadow_docs WHERE node_id=? AND source_id=? "
                                  "AND surface_original=?", (node, source, surface)).fetchone()[0]
            db.execute("INSERT OR IGNORE INTO shadow_postings SELECT gram,? FROM postings "
                       "WHERE node_id=? AND source_id=? AND surface_original=?",
                       (alias_id, node, source, surface))
        if interrupt:
            raise InterruptedError("injected rollback before durable cursor")
        db.execute("UPDATE copy_progress SET cursor=?", (json.dumps(rows[-1]),))
    return True


def rewrite(path):
    db = sqlite3.connect(path)
    db.executescript("PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=NORMAL;"
                     "PRAGMA cache_size=-32768;"
                     "CREATE TABLE shadow_docs(id INTEGER PRIMARY KEY,node_id TEXT NOT NULL,"
                     "source_id TEXT NOT NULL,surface_original TEXT NOT NULL,"
                     "UNIQUE(node_id,source_id,surface_original));"
                     "CREATE TABLE shadow_postings(gram TEXT NOT NULL,alias_id INTEGER NOT NULL "
                     "REFERENCES shadow_docs(id),PRIMARY KEY(gram,alias_id)) WITHOUT ROWID;"
                     "CREATE INDEX shadow_by_alias ON shadow_postings(alias_id);"
                     "CREATE TABLE copy_progress(cursor TEXT NOT NULL);")
    db.execute("INSERT INTO copy_progress VALUES(?)", (json.dumps(["", "", ""]),))
    db.commit()
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    started = time.perf_counter()
    samples, wal_peak = [], 0
    for i in range(1000):
        before = time.perf_counter()
        if not batch(db):
            break
        samples.append((time.perf_counter() - before) * 1000)
        wal = Path(str(path) + "-wal")
        wal_peak = max(wal_peak, wal.stat().st_size)
        db.execute("PRAGMA wal_checkpoint(PASSIVE)")
        if i == 4:
            progress = db.execute("SELECT cursor FROM copy_progress").fetchone()
            count = db.execute("SELECT COUNT(*) FROM shadow_postings").fetchone()
            try:
                batch(db, interrupt=True)
                raise AssertionError("interrupt did not happen")
            except InterruptedError:
                pass
            db.close()
            db = sqlite3.connect(path)
            db.executescript("PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=NORMAL;"
                             "PRAGMA cache_size=-32768;")
            assert db.execute("SELECT cursor FROM copy_progress").fetchone() == progress
            assert db.execute("SELECT COUNT(*) FROM shadow_postings").fetchone() == count
    elapsed = time.perf_counter() - started
    shadow = ("SELECT p.gram,a.node_id,a.source_id,a.surface_original FROM shadow_postings p "
              "JOIN shadow_docs a ON a.id=p.alias_id")
    original = "SELECT gram,node_id,source_id,surface_original FROM postings"
    assert db.execute(f"SELECT COUNT(*) FROM ({shadow} EXCEPT {original})").fetchone()[0] == 0
    assert db.execute(f"SELECT COUNT(*) FROM ({original} EXCEPT {shadow})").fetchone()[0] == 0
    count = db.execute("SELECT COUNT(*) FROM shadow_postings").fetchone()[0]
    changes = db.total_changes
    assert not batch(db)
    assert db.total_changes == changes  # Completed resume makes zero writes.
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    shadow_bytes = db.execute("SELECT SUM(pgsize) FROM dbstat WHERE name LIKE 'shadow_%' "
                              "OR name='sqlite_autoindex_shadow_docs_1'").fetchone()[0]
    db.close()
    return {"rewrite_s": elapsed, "batches": len(samples), "batch_max_ms": max(samples),
            "wal_peak_bytes": wal_peak, "shadow_bytes": shadow_bytes, "postings": count,
            "rollback_resume_exact": True, "completed_resume_changes": 0}
