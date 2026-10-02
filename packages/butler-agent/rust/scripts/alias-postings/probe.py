#!/usr/bin/env python3
"""Supplemental identity/FTS conformance probe and reverse-delete access plans."""

import json
from pathlib import Path
import sqlite3

from fixture import grams
from queries import alias_id_frequencies, bind, load
from variants import VARIANTS, insert_alias, install, write_plans


def connection():
    db = sqlite3.connect(":memory:")
    db.executescript("CREATE TABLE memory_nodes(id TEXT PRIMARY KEY,type TEXT,identity_scope TEXT,project_id TEXT);"
                     "CREATE TABLE memory_chunk_sources(source_id TEXT PRIMARY KEY,episode_id TEXT,revision TEXT,"
                     "source_kind TEXT,origin_kind TEXT,role TEXT,basis TEXT,observed_at TEXT);"
                     "CREATE TABLE memory_chunks(memory_chunk_id TEXT PRIMARY KEY,current_revision TEXT,"
                     "status TEXT,project_id TEXT,conversation_session_id TEXT);"
                     "CREATE TABLE memory_claims(node_id TEXT PRIMARY KEY,valid_from TEXT,valid_to TEXT);"
                     "CREATE TABLE memory_aliases(node_id TEXT,source_id TEXT,surface_original TEXT,"
                     "PRIMARY KEY(node_id,source_id,surface_original));"
                     "INSERT INTO memory_nodes VALUES('n1','entity','global',NULL),('n2','entity','global',NULL);"
                     "INSERT INTO memory_chunks VALUES('c','1','active',NULL,'session-0');"
                     "INSERT INTO memory_chunk_sources VALUES('s1','c','1','conversation','user_input',"
                     "'user','user_statement','2026-01-01'),('s2','c','1','conversation','user_input',"
                     "'user','user_statement','2026-01-01');")
    return db


def main():
    root = Path(__file__).resolve().parents[2]
    aliases = [("n1", "s1", "ababa", grams("ababa")),
               ("n1", "s1", "ababb", grams("ababb")),
               ("n2", "s2", "ababa", grams("ababa"))]
    results = {}
    for variant in VARIANTS:
        db = connection()
        storage = "compact" if variant == "compact_native" else variant
        install(db, storage)
        for i, alias in enumerate(aliases, 1):
            db.execute("INSERT INTO memory_aliases VALUES(?,?,?)", alias[:3])
            insert_alias(db, storage, i, alias)
        all_grams = sorted({g for alias in aliases for g in alias[3]})
        expected = [(g, sum(g in a[3] for a in aliases)) for g in all_grams]
        for query in load(root):
            if not query[0].endswith("frequencies"):
                continue
            sql, args = bind(query, "all", json.dumps(all_grams))
            if variant == "compact_native":
                sql = alias_id_frequencies(sql)
            actual = db.execute(sql, args).fetchall()
            native = [(g, n) for g, n in expected if len(g) == 3] if storage == "fts5_trigram" else expected
            assert actual == native, (variant, query[0], actual, native)
        results[variant] = {"multiple_surfaces_same_pair": True, "same_surface_different_pair": True,
                            "write_query_plans": write_plans(db, storage)}
        db.close()
    db = sqlite3.connect(":memory:")
    db.executescript("CREATE VIRTUAL TABLE f USING fts5(text,tokenize='trigram');"
                     "CREATE VIRTUAL TABLE v USING fts5vocab(f,'instance');")
    db.execute("INSERT INTO f VALUES(?)", ("a\u0301bc",))
    native = {r[0] for r in db.execute("SELECT term FROM v")}
    grapheme_grams = {"a\u0301b", "bc", "a\u0301bc"}
    assert native != grapheme_grams and "a\u0301bc" not in native
    results["unicode_counterexample"] = {"text": "a\u0301bc", "fts_terms": sorted(native),
                                          "butler_grapheme_grams": sorted(grapheme_grams)}
    db.close()
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
