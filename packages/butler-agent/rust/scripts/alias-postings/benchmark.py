#!/usr/bin/env python3
"""Owner-scale SQLite prototype, stdlib only. See ../../docs/alias-postings-redesign.md."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import sqlite3
import statistics
import tempfile
import time

from fixture import ALIASES, NODES, POSTINGS, eligibility, generate, grams, seed_graph
from queries import alias_id_frequencies, bind, load
from rewrite import rewrite
from variants import VARIANTS, insert_alias, install, write_plans


def wal_size(path):
    wal = Path(str(path) + "-wal")
    return wal.stat().st_size if wal.exists() else 0


def sizes(db):
    return dict(db.execute("SELECT name,SUM(pgsize) FROM dbstat GROUP BY name ORDER BY name"))


def oracle(aliases, nodes, mode, cue):
    eligible = eligibility(aliases, nodes, mode)
    query_grams = set(grams(cue))
    matched = sorted((a[0], a[1], a[2]) for a in eligible if query_grams.intersection(a[3]))
    expanded = set(query_grams)
    for node, source, surface in matched:
        expanded.update(grams(surface))
    counts = {}
    for alias in eligible:
        for gram in expanded.intersection(alias[3]):
            counts[gram] = counts.get(gram, 0) + 1
    return query_grams, expanded, matched, sorted(counts.items())


def measure(db, sql, args, expected, repeats, native_expected=None):
    plan = [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql, args)]
    times = []
    correct = True
    # First statement execution; connection and OS caches may already be warm.
    for _ in range(repeats + 1):
        start = time.perf_counter()
        actual = db.execute(sql, args).fetchall()
        times.append((time.perf_counter() - start) * 1000)
        same = actual == expected  # Counts AND text AND total order, no LIMIT/deadline.
        correct &= same
        native = expected if native_expected is None else native_expected
        assert actual == native, (sql, len(actual), len(native), actual[:2], native[:2])
    return {"first_ms": times[0], "median_ms": statistics.median(times[1:]),
            "max_ms": max(times[1:]), "rows": len(actual), "expected_rows": len(expected),
            "correct": correct, "sha256": hashlib.sha256(repr(actual).encode()).hexdigest(),
            "plan": plan, "sql": sql, "binds": args}


def reads(db, root, aliases, nodes, repeats, variant):
    results = {}
    queries = load(root)
    cues = {"mixed": aliases[1][2][:8], "bigram": aliases[1][2][:2]}
    for mode in ("all", "project", "session", "internal", "registration"):
        for cue_name, cue in cues.items():
            qgrams, expanded, matched, counts = oracle(aliases, nodes, mode, cue)
            for query in queries:
                name, _, line, path, _ = query
                if name.startswith("registration") != (mode == "registration"):
                    continue
                is_postings = name.endswith("postings")
                payload = json.dumps(sorted(qgrams if is_postings else expanded), ensure_ascii=False)
                sql, args = bind(query, mode, payload)
                if variant == "compact_native" and not is_postings:
                    sql = alias_id_frequencies(sql)
                native = None
                if variant == "fts5_trigram":
                    native = (sorted((a[0], a[1], a[2]) for a in eligibility(aliases, nodes, mode)
                                     if {g for g in qgrams if len(g) == 3}.intersection(a[3]))
                              if is_postings else [(g, n) for g, n in counts if len(g) == 3])
                result = measure(db, sql, args, matched if is_postings else counts,
                                 repeats, native)
                result["source"] = f"{path}:{line}"
                # Keep full binds reproducible but do not repeat huge expanded gram lists.
                result["gram_count"] = len(qgrams if is_postings else expanded)
                result["binds"] = ["<grams JSON>" if x == payload else x for x in args]
                results[f"{mode}.{cue_name}.{name}"] = result
    return results


def update_probe(db, variant, aliases, nodes, root):
    current = list(aliases)
    samples = []
    for i in range(1, 65):
        node, source, surface, _ = current[i]
        start = time.perf_counter()
        db.execute("BEGIN IMMEDIATE")
        if variant.startswith("fts5"):
            db.execute("INSERT INTO alias_fts(alias_fts,rowid,surface_original) VALUES('delete',?,?)",
                       (i + 1, surface))
        if variant in ("compact", "fts5_hybrid"):
            db.execute("DELETE FROM compact_postings WHERE alias_id=?", (i + 1,))
        elif variant != "fts5_trigram":
            keys = (node, source, surface)
            if variant == "surface_once":
                keys = (node, source, i + 1)
            if variant == "integers":
                keys = (db.execute("SELECT id FROM node_keys WHERE text_id=?", (node,)).fetchone()[0],
                        db.execute("SELECT id FROM source_keys WHERE text_id=?", (source,)).fetchone()[0], i + 1)
            db.execute("DELETE FROM postings WHERE node_id=? AND source_id=? AND surface_original=?", keys)
        if variant in ("surface_once", "integers", "compact", "fts5_trigram", "fts5_hybrid"):
            db.execute("DELETE FROM alias_docs WHERE id=?", (i + 1,))
        replacement = surface[::-1]
        db.execute("UPDATE memory_aliases SET surface_original=?,nfc_key=?,folded_key=? "
                   "WHERE node_id=? AND source_id=? AND surface_original=?",
                   (replacement, replacement, replacement, node, source, surface))
        current[i] = (node, source, replacement, grams(replacement))
        insert_alias(db, variant, i + 1, current[i])
        db.commit()
        samples.append((time.perf_counter() - start) * 1000)
    query = next(q for q in load(root) if q[0] == "recall.postings")
    qgrams, _, expected, _ = oracle(current, nodes, "all", current[1][2][:8])
    sql, args = bind(query, "all", json.dumps(sorted(qgrams), ensure_ascii=False))
    native = None
    if variant == "fts5_trigram":
        native = sorted((a[0], a[1], a[2]) for a in eligibility(current, nodes, "all")
                        if {g for g in qgrams if len(g) == 3}.intersection(a[3]))
    latest = measure(db, sql, args, expected, 1, native)
    return {"aliases": 64, "median_ms": statistics.median(samples), "max_ms": max(samples),
            "latest_state": latest}


def run_variant(directory, root, variant, nodes, aliases, repeats):
    path = directory / f"{variant}.sqlite"
    db = sqlite3.connect(path)
    db.executescript("PRAGMA page_size=4096; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;"
                     "PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=-32768; PRAGMA foreign_keys=ON;")
    seed_graph(db, root, nodes, aliases)
    storage = "compact" if variant == "compact_native" else variant
    install(db, storage)
    db.commit()
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    started = time.perf_counter()
    peak = 0
    batch_times = []
    for offset in range(0, len(aliases), 128):
        before = time.perf_counter()
        with db:
            for i in range(offset, min(offset + 128, len(aliases))):
                insert_alias(db, storage, i + 1, aliases[i])
        batch_times.append((time.perf_counter() - before) * 1000)
        peak = max(peak, wal_size(path))
        # Approximate bounded WAL maintenance between leases; not timed as SQL insert.
        db.execute("PRAGMA wal_checkpoint(PASSIVE)")
    build_s = time.perf_counter() - started
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    breakdown = sizes(db)
    allocated = path.stat().st_size
    print(f"{variant}: built {allocated / 1048576:.2f} MiB; measuring reads", flush=True)
    actual_rows = db.execute("SELECT COUNT(*) FROM memory_alias_postings").fetchone()[0]
    if variant != "fts5_trigram":
        assert actual_rows == POSTINGS, (variant, actual_rows)
    db.close()
    db = sqlite3.connect(path)  # New page cache for read measurements.
    db.execute("PRAGMA cache_size=-32768")
    read_results = reads(db, root, aliases, nodes, repeats, variant)
    write_query_plans = write_plans(db, storage)
    update_settings = {key: db.execute(f"PRAGMA {key}").fetchone()[0]
                       for key in ("synchronous", "wal_autocheckpoint", "foreign_keys")}
    writes = update_probe(db, storage, aliases, nodes, root)
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    before_idle = db.total_changes
    # Exercise a read after writes; total_changes must remain stable.
    db.execute("SELECT COUNT(*) FROM memory_aliases").fetchone()
    assert db.total_changes == before_idle
    db.close()
    return {"db_bytes": allocated, "dbstat_bytes": breakdown, "postings": actual_rows,
            "build_s": build_s, "build_ms_per_alias": build_s * 1000 / ALIASES,
            "batch_max_ms": max(batch_times), "wal_peak_bytes": peak,
            "queries": read_results, "write_query_plans": write_query_plans,
            "update_settings": update_settings, "update": writes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="JSON evidence, outside source tree")
    parser.add_argument("--variants", nargs="+", choices=VARIANTS, default=list(VARIANTS))
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    assert args.repeats >= 1
    # Caller MUST isolate both dirs; refuse an unset BUTLER_DATA or owner HOME.
    temp_root = Path(os.environ.get("TMPDIR", "/tmp")).resolve()
    for name in ("HOME", "BUTLER_DATA"):
        candidate = Path(os.environ[name]).resolve()
        assert candidate.is_relative_to(temp_root), (name, "must be isolated under TMPDIR")
    root = Path(__file__).resolve().parents[2]
    nodes, aliases = generate()
    report = {"sqlite": sqlite3.sqlite_version, "platform": platform.platform(),
              "nodes": NODES, "aliases": ALIASES, "postings": POSTINGS,
              "avg_surface_chars": 83,
              "avg_surface_utf8_bytes": statistics.mean(len(a[2].encode()) for a in aliases),
              "variants": {}}
    with tempfile.TemporaryDirectory(prefix="alias-postings-", dir=temp_root) as directory:
        for variant in args.variants:
            result = run_variant(Path(directory), root, variant, nodes, aliases, args.repeats)
            report["variants"][variant] = result
            args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
            print(f"{variant}: {result['db_bytes'] / 1048576:.2f} MiB, "
                  f"build {result['build_s']:.2f}s, max batch {result['batch_max_ms']:.2f}ms", flush=True)
        if "baseline" in args.variants:
            report["rewrite"] = rewrite(Path(directory) / "baseline.sqlite")
            args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
            print("rewrite:", json.dumps(report["rewrite"]), flush=True)


if __name__ == "__main__":
    main()
