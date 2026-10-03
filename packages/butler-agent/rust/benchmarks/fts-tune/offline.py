"""Bounded offline FTS round: dev selection, frozen winner, single held-out score.

No model calls or product writes. Inputs are private noembed research artifacts.
Outputs must be outside the repo; the SQLite snapshot is read-only and copied
with SQLite backup. This reproduces the documented RRF60 diagnostic, not native
freshness/hydration/ranking. Never treat these scores as product acceptance.
"""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import statistics
import time
import unicodedata

FIELDS = ("summary", "entities", "claims", "source")
STYLES = ("keyword", "paraphrase", "vague", "vague-extra", "original", "all")
RANGES = ((0x1100, 0x11ff), (0x2e80, 0x2fff), (0x3040, 0x30ff),
          (0x3130, 0x318f), (0x31a0, 0x31bf), (0x31f0, 0x31ff),
          (0x3400, 0x4dbf), (0x4e00, 0x9fff), (0xa960, 0xa97f),
          (0xac00, 0xd7ff), (0xf900, 0xfaff), (0xff66, 0xff9d),
          (0x20000, 0x323af))
# Fixed before any scores: no language detection, stopwords or language thresholds.
CONFIGS = {
    "baseline": ("2u", False, (4, 2, 1, .25), False),
    "no-index-unigrams": ("2", False, (4, 2, 1, .25), False),
    "bigram-prefix": ("2", True, (4, 2, 1, .25), False),
    "bigram-trigram": ("23", False, (4, 2, 1, .25), False),
    "bigram-trigram-prefix": ("23", True, (4, 2, 1, .25), False),
    "trigram-prefix": ("3", True, (4, 2, 1, .25), False),
    "entity-weight": ("23", True, (2, 4, 1, .25), False),
    "source-weight": ("23", True, (4, 2, 1, 1), False),
    "equal-fields": ("23", True, (1, 1, 1, 1), False),
    "summary-weight": ("23", True, (8, 2, 1, .25), False),
    "rare-query": ("23", True, (4, 2, 1, .25), True),
    "bigram-rare-query": ("2", True, (4, 2, 1, .25), True),
}


def read(path):
    return json.loads(path.read_text())


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def cjk(char):
    return any(start <= ord(char) <= end for start, end in RANGES)


def tokens(text, mode, query=False):
    text = unicodedata.normalize("NFKC", text).casefold()
    runs, run, kind = [], "", False
    for char in text:
        mark = unicodedata.category(char).startswith("M")
        if char.isalnum() or mark:
            if run and cjk(char) != kind and not mark:
                runs.append((run, kind))
                run = ""
            if not run:
                kind = cjk(char)
            run += char
        elif run:
            runs.append((run, kind))
            run = ""
    if run:
        runs.append((run, kind))
    out = set()
    unigram = sum(cjk(c) for c in text) == 1 if query else "u" in mode
    for word, kind in runs:
        out.add(word)
        if kind:
            for n in (2, 3):
                if str(n) in mode:
                    for i in range(len(word) - n + 1):
                        out.add("cjk" + "x".join(f"{ord(c):x}" for c in word[i:i+n]))
            if unigram:
                out.update(f"uni{ord(c):x}" for c in word)
    return sorted(out)


def build(path, docs, mode):
    db = sqlite3.connect(path)
    db.execute("PRAGMA cache_size=-8192")
    db.execute("CREATE VIRTUAL TABLE ft USING fts5(summary,entities,claims,source)")
    db.execute("CREATE TABLE meta(id INTEGER PRIMARY KEY,episode TEXT,project TEXT)")
    db.execute("CREATE INDEX project_idx ON meta(project)")
    df = collections.Counter()
    for doc in docs:
        fields = [tokens(doc[field] or "", mode) for field in FIELDS]
        df.update(set(t for field in fields for t in field))
        db.execute("INSERT INTO meta VALUES(?,?,?)", (doc["rowid"], doc["id"], doc["project"]))
        db.execute("INSERT INTO ft(rowid,summary,entities,claims,source) VALUES(?,?,?,?,?)",
                   (doc["rowid"], *(" ".join(field) for field in fields)))
    db.commit()
    db.execute("INSERT INTO ft(ft) VALUES('integrity-check')")
    assert db.execute("SELECT count(*) FROM ft").fetchone()[0] == len(docs)
    db.execute("PRAGMA query_only=ON")
    return db, df


def search(db, df, q, config):
    mode, prefix, weights, rare = config
    terms = tokens(q["query"], mode, query=True)
    if rare and terms:
        # Generic corpus-frequency noise suppression; unseen terms have no postings.
        seen = [t for t in terms if df[t]]
        median = statistics.median(df[t] for t in seen) if seen else 0
        terms = [t for t in terms if df[t] <= median]
    if not terms:
        return [], 0
    expression = " OR ".join('"' + t + '"' +
                             ("*" if prefix and not t.startswith(("cjk", "uni")) else "")
                             for t in terms)
    sql = ("SELECT m.episode FROM ft JOIN meta m ON m.id=ft.rowid WHERE ft MATCH ? "
           "AND (? IS NULL OR m.project=?) ORDER BY bm25(ft," +
           ",".join(map(str, weights)) + "),m.episode")
    args = (expression, q["binding"]["project_id"], q["binding"]["project_id"])
    start = time.perf_counter()
    hits = [row[0] for row in db.execute(sql + " LIMIT 30", args)]
    ms = (time.perf_counter() - start) * 1000
    assert hits == [row[0] for row in db.execute(sql, args)][:30]
    assert len(hits) == len(set(hits))
    return hits, ms


def fuse(base, hits):
    scores = collections.defaultdict(float)
    for lane in (base[:30], hits):
        for rank, episode in enumerate(lane, 1):
            scores[episode] += 1 / (60 + rank)
    return sorted(scores, key=lambda e: (-scores[e], e))[:30]


def gold(q):
    return {hashlib.sha256(e.encode()).hexdigest() for e in q["gold_episode_ids"]}


def rank(q, ids):
    return next((i for i, e in enumerate(ids, 1) if e in gold(q)), math.inf)


def aggregate(qs, rows):
    result = {}
    for style in STYLES:
        ids = [i for i in rows if style == "all" or qs[i]["style"] == style or
               (style == "original" and qs[i]["style"] != "vague-extra")]
        ranks = [rank(qs[i], rows[i]["union"]) for i in ids]
        result[style] = {"n": len(ids), **{f"hits{k}": sum(r <= k for r in ranks)
                                         for k in (1, 5, 15, 30)},
                         "median_ms": statistics.median(rows[i]["ms"] for i in ids)}
    return result


def evaluate(qs, ids, config, index, base):
    rows = {}
    db, df = index
    for i in ids:
        hits, ms = search(db, df, qs[i], config)
        rows[i] = {"fts": hits, "union": fuse(base[i], hits), "ms": ms}
    return rows


def snapshot_copy(snapshot, output, docs):
    before = digest(snapshot)
    src = sqlite3.connect(f"file:{snapshot}?mode=ro&immutable=1", uri=True)
    src.execute("PRAGMA query_only=ON")
    with sqlite3.connect(output / "snapshot.sqlite") as dst:
        src.backup(dst)
    current = {hashlib.sha256(e.encode()).hexdigest(): revision for e, revision in
               src.execute("SELECT memory_chunk_id,current_revision FROM memory_chunks WHERE status='active'")}
    assert all(current[d["id"]] == d["revision"] for d in docs)
    src.close()
    assert digest(snapshot) == before
    return before


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    out, artifacts = args.output.resolve(), args.artifacts.resolve()
    assert not out.is_relative_to(Path(__file__).resolve().parents[6])
    out.mkdir(parents=True, exist_ok=False)
    qs, docs = read(artifacts / "questions.json"), read(artifacts / "docs.json")
    protocol = read(artifacts / "protocol.json")
    snapshot_sha = snapshot_copy(args.snapshot, out, docs)
    base = {r["id"]: [m["episode_sha256"] for m in sorted(r["candidate_metrics"], key=lambda m: m["rank"])]
            for r in map(json.loads, (artifacts / "harness/results.jsonl").open())}
    assert set(qs) == set(base) == set(protocol["split"])
    assert len(docs) == 714 and len(qs) == 244
    indexes = {mode: build(out / (mode + ".sqlite"), docs, mode)
               for mode in sorted({c[0] for c in CONFIGS.values()})}
    dev_ids = [i for i in qs if protocol["split"][i] == "dev"]
    dev_rows = {name: evaluate(qs, dev_ids, config, indexes[config[0]], base)
                for name, config in CONFIGS.items()}
    dev = {name: aggregate(qs, rows) for name, rows in dev_rows.items()}
    eligible = [name for name in CONFIGS if dev[name]["keyword"]["hits15"] >=
                dev["baseline"]["keyword"]["hits15"] and dev[name]["keyword"]["hits5"] >=
                dev["baseline"]["keyword"]["hits5"]]
    winner = max(eligible, key=lambda name: (dev[name]["all"]["hits30"],
                 dev[name]["all"]["hits15"], -dev[name]["all"]["median_ms"]))
    frozen = {"winner": winner, "configs": CONFIGS, "dev": dev,
              "snapshot_sha256": snapshot_sha, "script_sha256": digest(Path(__file__)),
              "input_sha256": {str(p.relative_to(artifacts)): digest(p) for p in
                  [artifacts / "questions.json", artifacts / "docs.json",
                   artifacts / "protocol.json", artifacts / "harness/results.jsonl"]}}
    (out / "freeze.json").write_text(json.dumps(frozen, indent=2))
    # Only the selected variant and baseline are scored on held-out questions.
    held_ids = [i for i in qs if protocol["split"][i] == "heldout"]
    held_rows = {name: evaluate(qs, held_ids, CONFIGS[name], indexes[CONFIGS[name][0]], base)
                 for name in dict.fromkeys(("baseline", winner))}
    held = {name: aggregate(qs, rows) for name, rows in held_rows.items()}
    (out / "private-orders.json").write_text(json.dumps({"dev": dev_rows, "heldout": held_rows}))
    report = {"winner": winner, "dev": dev, "heldout": held,
              "indexed_rows": len(docs), "snapshot_unchanged": digest(args.snapshot) == snapshot_sha}
    (out / "report.json").write_text(json.dumps(report, indent=2))
    assert report["snapshot_unchanged"]
    print(json.dumps(report, indent=2))
    for db, _ in indexes.values():
        db.close()


if __name__ == "__main__":
    main()
