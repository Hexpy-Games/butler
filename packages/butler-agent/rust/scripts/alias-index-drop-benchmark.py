#!/usr/bin/env python3
"""Reproducible synthetic owner-scale audit; never opens owner data or VACUUMs.

Extracts the four posting SELECT templates directly from production Rust.
Also checks each posting DELETE template, including the trigger delete.
Run under isolated HOME/BUTLER_DATA; the database is temporary.
"""
import json
import re
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GRAPH = ROOT / "crates/butler-memory/src/cognition/graph"
INDEXES = {
    "idx_alias_postings_entity": "node_id,gram,source_id,surface_original",
    "idx_alias_postings_scope_gram_node": "identity_scope,project_id,gram,node_id",
}
NOW = "2026-10-02T00:00:00Z"


def strings(path):
    # SQL templates here use ordinary Rust strings, including line continuation.
    source = path.read_text()
    return [re.sub(r"\\\n\s*", "", text) for text in re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', source, re.S)]


def queries():
    selection = strings(GRAPH / "candidates/selection.rs")
    eligible = next(s for s in selection if s.startswith("c.status="))
    templates = [("selection", s.replace("{ELIGIBLE}", eligible), [None, NOW, '["ab","abc"]'])
                 for s in selection if "FROM memory_alias_postings p" in s]
    lexical = strings(GRAPH / "recall/semantic/lexical.rs")
    alias_join = next(s for s in lexical if s.startswith("JOIN memory_nodes e"))
    predicates = strings(GRAPH / "recall/scope.rs")
    claim_types = "'preference','goal','constraint','decision','memory_atom'"
    claims = [text.replace("{entity}", "e").replace("{target}", "e.id").replace("{claim_types}", claim_types)
              for text in predicates if text.startswith("({entity}.type NOT IN")]
    assert len(claims) == 2
    typed = next(text for text in predicates if text.startswith("({source}.source_kind='task_report'"))
    scopes = [("any", "", []), ("unassigned", " AND c.project_id IS NULL", []),
              ("project", " AND c.project_id=?", ["project"]),
              ("session", " AND c.conversation_session_id=?", ["session"]),
              ("selected-project", " AND c.conversation_session_id IN (?,?) AND c.project_id IN (?,?)",
               ["session", "other", "project", "other"])]
    for internal in [False, True]:
        conversation = next(text for text in predicates if text.startswith("{source}.source_kind='conversation'")
                            and ("internal_control" in text) == internal)
        visible = ("c.status='active' AND ((" + conversation + ") OR (" + typed + "))").replace("{source}", "s")
        for basis in ["as-of", "conversation-time", "event-time"]:
            claim = claims[0] if basis == "event-time" else claims[1]
            claim_args = ["2027-01-01", "2027-01-01", "2025-01-01"] if basis == "event-time" else [NOW, NOW]
            for name, scope, scope_args in scopes:
                source = visible + scope + " AND julianday(s.observed_at)<=julianday(?)"
                source_args = scope_args + [NOW]
                if basis == "conversation-time":
                    source += " AND julianday(s.observed_at)>=julianday(?) AND julianday(s.observed_at)<julianday(?)"
                    source_args += ["2025-01-01", "2027-01-01"]
                for sql in lexical:
                    if "FROM memory_alias_postings p" not in sql:
                        continue
                    sql = sql.replace("{ALIAS_JOIN}", alias_join).replace("{}", claim, 1).replace("{}", source, 1)
                    args = claim_args + source_args
                    values = args + ['["ab","abc"]'] if sql.startswith("WITH") else ['["ab","abc"]'] + args
                    templates.append((f"recall {name} internal={internal} {basis}", sql, values))
    assert len(templates) == 62, len(templates)
    return templates


def seed(db):
    db.executescript((ROOT / "crates/butler-e2e/fixtures/F-memory-empty/graph.sql").read_text())
    db.executescript("CREATE TABLE memory_claims(node_id TEXT PRIMARY KEY,valid_from TEXT,valid_to TEXT);")
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA wal_autocheckpoint=0")
    # 16,561 aliases, UUID-sized nodes, hash-sized sources, 83-byte surfaces.
    db.executescript("""BEGIN;
    WITH RECURSIVE ids(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM ids WHERE n<16560)
    INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at)
    SELECT printf('%036d',n),'entity','alias','user','now' FROM ids;
    INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at)
    SELECT id,id,'1','session',CASE WHEN rowid%2=0 THEN 'project' END,'user_input','active',id,'now','now' FROM memory_nodes;
    INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis)
    SELECT printf('%064d',rowid-1),id,'1','conversation',id,'',0,83,id,'user','user_input','2026-01-01','user_statement' FROM memory_nodes;
    INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind)
    SELECT id,printf('%083d',rowid),'alias','alias',printf('%064d',rowid-1),'new' FROM memory_nodes;
    WITH RECURSIVE ids(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM ids WHERE n<886339)
    INSERT INTO memory_alias_postings
    SELECT CASE WHEN n%54=0 THEN 'ab' WHEN n%54=1 THEN 'abc' ELSE printf('%03d',n%54) END,
      printf('%036d',n/54),printf('%064d',n/54),printf('%083d',n/54+1),'user',NULL FROM ids;
    CREATE INDEX idx_alias_postings_gram_source ON memory_alias_postings(gram,node_id,source_id);
    CREATE INDEX idx_alias_postings_alias ON memory_alias_postings(node_id,source_id,surface_original,gram);
    COMMIT;""")
    for name, columns in INDEXES.items():
        db.execute(f"CREATE INDEX {name} ON memory_alias_postings({columns})")
    db.commit()
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    assert db.execute("SELECT COUNT(*) FROM memory_alias_postings").fetchone()[0] == 886340


def snapshot(db, templates):
    result = []
    for label, sql, args in templates:
        plan = list(db.execute("EXPLAIN QUERY PLAN " + sql, args))
        assert not any(name in str(plan) for name in INDEXES), plan
        rows = list(db.execute(sql, args))
        result.append((plan, rows))
    db.commit()
    return result


def insert_cost(db):
    started = time.perf_counter()
    db.execute("BEGIN")
    for i in range(1000):
        # A whole alias insertion: all 54 postings; preserve every field.
        db.executemany("INSERT INTO memory_alias_postings VALUES(?,?,?,?,?,?)", [
            (f"{g:03d}", f"bench-{i:030d}", f"{i:064d}", f"{i:083d}", "user", None) for g in range(54)
        ])
    db.commit()
    elapsed = (time.perf_counter() - started) * 1000 / 1000
    actual = list(db.execute("SELECT * FROM memory_alias_postings WHERE node_id LIKE 'bench-%' ORDER BY node_id,gram"))
    expected = [(f"{g:03d}", f"bench-{i:030d}", f"{i:064d}", f"{i:083d}", "user", None)
                for i in range(1000) for g in range(54)]
    assert actual == expected
    db.execute("DELETE FROM memory_alias_postings WHERE node_id LIKE 'bench-%'")
    db.commit()
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return elapsed


def main():
    if len(sys.argv) == 2 and sys.argv[1].startswith("--prepare="):
        directory = Path(sys.argv[1].split("=", 1)[1])
        directory.mkdir(parents=True)
        db = sqlite3.connect(directory / "graph.sqlite")
        seed(db)
        db.close()
        (directory / "queries.json").write_text(json.dumps(queries() + [
            ("delete", "DELETE FROM memory_alias_postings WHERE node_id=?1 AND source_id=?2 AND surface_original=?3",
             ["missing", "missing", "missing"])]))
        return
    with tempfile.TemporaryDirectory(prefix="alias-index-audit-") as directory:
        path = Path(directory) / "graph.sqlite"
        db = sqlite3.connect(path, cached_statements=0)
        seed(db)
        templates = queries()
        # The production posting deletes use the retained alias prefix index.
        for sql in set(s for s in strings(GRAPH / "recall_index.rs") if s.startswith("DELETE FROM memory_alias_postings WHERE")):
            templates.append(("delete", sql, ["missing", "missing", "missing"]))
        before = snapshot(db, templates)
        expected_counts = [0 if label == "delete" else 2 if sql.startswith("WITH") else
                           8207 if label == "selection" or "project" in label or "unassigned" in label else 16414
                           for label, sql, _ in templates]
        assert [len(rows) for _, rows in before] == expected_counts
        write_before = insert_cost(db)
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        size_before = path.stat().st_size
        drops = []
        for name in INDEXES:
            freelist_before = db.execute("PRAGMA freelist_count").fetchone()[0]
            started = time.perf_counter()
            db.execute(f"DROP INDEX IF EXISTS {name}")
            db.commit()
            drops.append({"index": name, "ms": (time.perf_counter()-started)*1000,
                          "wal_bytes": Path(str(path)+"-wal").stat().st_size,
                          "freed_pages": db.execute("PRAGMA freelist_count").fetchone()[0]-freelist_before})
            assert snapshot(db, templates) == before
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        size_after = path.stat().st_size
        free_after = db.execute("PRAGMA freelist_count").fetchone()[0]
        write_after = insert_cost(db)
        assert db.execute("SELECT COUNT(*) FROM memory_alias_postings").fetchone()[0] == 886340
        print(json.dumps({"sqlite": sqlite3.sqlite_version, "postings": 886340,
            "query_variants": len(templates), "identical_plans_and_results": True,
            "plans": [plan for plan, _ in before], "result_counts": [len(rows) for _, rows in before],
            "drops": drops, "file_bytes_before": size_before, "file_bytes_after": size_after,
            "freelist_pages_after": free_after, "page_size": db.execute("PRAGMA page_size").fetchone()[0],
            "alias_insert_ms_before": write_before, "alias_insert_ms_after": write_after,
            "vacuum": False}, indent=2))
        db.close()


if __name__ == "__main__":
    main()
