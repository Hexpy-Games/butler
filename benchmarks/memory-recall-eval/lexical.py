"""Local lexical and recorded-alias diagnostic floor over the same corpus."""

import argparse
import json
import math
import re
import time
from collections import Counter
from pathlib import Path

TOKEN = re.compile(r"[\w./#-]+", re.UNICODE)
STOP = set("what did the stored source say about find for which record specifically mentions as of recorded date was connects with 에 관한 기록의 근거는 무엇인가요".split())


def terms(text):
    return {word.casefold() for word in TOKEN.findall(text) if len(word) >= 2 and word.casefold() not in STOP}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    dataset = json.loads(args.dataset.read_text())
    start = time.perf_counter()
    docs = dataset["documents"]
    indexed = [(doc, terms(doc["text"]), terms(" ".join(doc.get("aliases", [])))) for doc in docs]
    df = Counter(word for _, words, aliases in indexed for word in words | aliases)
    ingest_ms = (time.perf_counter() - start) * 1000
    scores = []
    query_ms = []
    for query in dataset["queries"]:
        start = time.perf_counter()
        cue = terms(query["text"])
        ranked = []
        for doc, words, aliases in indexed:
            overlap = cue & (words | aliases)
            score = sum(math.log1p(len(docs) / df[word]) * (2 if word in aliases else 1)
                        for word in overlap)
            ranked.append((score, doc["id"]))
        ranked.sort(key=lambda row: (-row[0], row[1]))
        rank = next((position for position, (_, source_id) in enumerate(ranked, 1)
                     if source_id in query["gold_source_ids"]), None)
        top = next(doc for doc in docs if doc["id"] == ranked[0][1])
        scores.append({"id": query["id"], "category": query["category"],
                       "mode": query["mode"], "rank": rank,
                       "evidence_found": query["gold_answer"] in top["text"]})
        query_ms.append((time.perf_counter() - start) * 1000)
    result = {"arm": "lexical-alias-proxy", "summary": {"scores": scores,
              "query_ms": query_ms, "ingest_ms": ingest_ms, "document_vectors": 0},
              "idle": None, "after": None}
    args.output.write_text(json.dumps(result) + "\n")
    print(json.dumps({"queries": len(scores), "documents": len(docs)}))


if __name__ == "__main__":
    main()
