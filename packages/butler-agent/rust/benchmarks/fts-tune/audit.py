"""Audit historical judge hits absent from the frozen neutral diagnostic pool.

Consumes offline.py's private output; does not search or select any variant.
Writes private per-question rows outside the repo and prints aggregate counts.
"""
import argparse
import collections
import json
import math
from pathlib import Path

from offline import FIELDS, gold, rank, read, tokens


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    assert not args.output.resolve().is_relative_to(Path(__file__).resolve().parents[6])
    qs = read(args.artifacts / "questions.json")
    docs = {d["id"]: d for d in read(args.artifacts / "docs.json")}
    orders = read(args.output / "private-orders.json")["heldout"]
    historical = read(args.artifacts / "heldout-final-orders.json")["best-judge"]
    korean = read(args.artifacts / "korean.json")
    rows = []
    for i in historical:
        if rank(qs[i], historical[i]) > 5 or rank(qs[i], orders["baseline"][i]["union"]) <= 15:
            continue
        terms = set(tokens(qs[i]["query"], "2u", query=True))
        overlap = {f: max(len(terms & set(tokens(docs[e][f] or "", "2u")))
                          for e in gold(qs[i])) for f in FIELDS}
        ranks = {"neutral_union": rank(qs[i], orders["baseline"][i]["union"]),
                 "neutral_fts": rank(qs[i], orders["baseline"][i]["fts"]),
                 "research_fts": rank(qs[i], korean[i]["ko2"]["ids"])}
        rows.append({"id": i, "style": qs[i]["style"], "overlap": overlap,
                     **{name: None if value == math.inf else value for name, value in ranks.items()}})
    (args.output / "miss-diagnostics.json").write_text(json.dumps(rows, indent=2))
    report = {"misses": len(rows), "styles": dict(collections.Counter(r["style"] for r in rows)),
              "union_ranks16_30": sum(r["neutral_union"] is not None for r in rows),
              "neutral_fts_outside30": sum(r["neutral_fts"] is None for r in rows),
              "research_fts_within30": sum(r["research_fts"] is not None for r in rows),
              "gold_fields_with_query_overlap": {f: sum(r["overlap"][f] > 0 for r in rows) for f in FIELDS}}
    (args.output / "miss-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
