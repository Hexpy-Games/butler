"""Aggregate private run records without publishing queries or source text."""

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[math.ceil(len(ordered) * fraction) - 1]


def metrics(scores, timings):
    total = len(scores)
    ranks = [score["rank"] for score in scores]
    return {
        "n": total,
        "recall_at_1": round(sum(rank == 1 for rank in ranks) / total, 4),
        "recall_at_5": round(sum(rank is not None and rank <= 5 for rank in ranks) / total, 4),
        "mrr": round(sum(1 / rank for rank in ranks if rank is not None) / total, 4),
        "ndcg_at_10": round(sum(1 / math.log2(rank + 1) for rank in ranks
                                if rank is not None and rank <= 10) / total, 4),
        "evidence_found": round(sum(score["evidence_found"] for score in scores) / total, 4),
        "latency_p50_ms": round(statistics.median(timings), 1),
        "latency_p95_ms": round(percentile(timings, 0.95), 1),
    }


def summarize(run):
    summary = run["summary"]
    grouped = defaultdict(list)
    grouped_times = defaultdict(list)
    for score, timing in zip(summary["scores"], summary["query_ms"], strict=True):
        grouped[score["category"]].append(score)
        grouped_times[score["category"]].append(timing)
    result = {
        "arm": run["arm"],
        "overall": metrics(summary["scores"], summary["query_ms"]),
        "by_category": {category: metrics(scores, grouped_times[category])
                        for category, scores in sorted(grouped.items())},
        "ingest_ms": round(summary["ingest_ms"]),
        "vector_count": summary["document_vectors"],
        "worker_idle_mib": round(run["idle"]["physical_bytes"] / 1048576) if run["idle"] else None,
        "worker_peak_mib": round(run["after"]["peak_bytes"] / 1048576) if run["after"] else None,
        "misses_at_5": {category: sum(score["rank"] is None or score["rank"] > 5
                                      for score in scores)
                        for category, scores in sorted(grouped.items())},
    }
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    results = []
    for line in args.input.read_text().splitlines():
        run = json.loads(line)
        if "error" in run:
            results.append({"arm": run["arm"], "error": run["error"]})
        else:
            results.append(summarize(run))
    args.output.write_text(json.dumps(results, indent=2))
    print(json.dumps({"arms": len(results), "failed": sum("error" in row for row in results)}))


if __name__ == "__main__":
    main()
