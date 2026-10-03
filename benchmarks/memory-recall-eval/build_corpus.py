"""Build an owner-local, untracked recall corpus from Butler's stored evidence.

The output contains private source text. Never commit or upload it. SQLite is
opened immutable so this program cannot create WAL or journal files in DATA.
"""

import argparse
import hashlib
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

CATEGORIES = ("conversation_short", "conversation_long", "web", "learned", "project", "temporal")
LIMIT = 50
WORD = re.compile(r"[\w./#-]+", re.UNICODE)
DATE = re.compile(r"\b20\d\d[-./년 ]\d{1,2}|\b(?:now|currently|previously|until|since)\b", re.I)
NEGATION = re.compile(r"\b(?:not|never|no longer|instead|don't|cannot)\b|아니|않|말고|정정")


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()[:20]


def item(category, text, source, observed_at=""):
    text = re.sub(r"\s+", " ", text).strip()
    ko = bool(re.search(r"[가-힣]", text))
    en = bool(re.search(r"[A-Za-z]{4}", text))
    return {"id": digest(category + "\n" + text), "category": category,
            "origin": "real", "source": source, "observed_at": observed_at,
            "language": "mixed" if ko and en else "ko" if ko else "en", "text": text}


def graph_items(root):
    generation = json.loads((root / "cognition/memory/active-generation.json").read_text())
    generation_id = generation.get("generationId") or generation.get("generation_id")
    if not generation_id:
        raise ValueError("active generation ID unavailable")
    path = root / "cognition/memory/generations" / generation_id / "graph.sqlite"
    db = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    source_aliases = defaultdict(list)
    node_aliases = defaultdict(list)
    for node_id, surface, source_id in db.execute(
        "SELECT node_id,surface_original,source_id FROM memory_aliases ORDER BY node_id LIMIT 100000"
    ):
        if surface and len(surface) <= 80:
            if source_id and len(source_aliases[source_id]) < 12:
                source_aliases[source_id].append(surface)
            if len(node_aliases[node_id]) < 12:
                node_aliases[node_id].append(surface)
    sql = """SELECT s.source_id,s.observed_at,t.text FROM memory_chunk_sources s
             JOIN memory_source_text t ON t.source_id=s.source_id
             WHERE s.origin_kind IN ('user_input','assistant_public')
             ORDER BY s.observed_at DESC,s.source_id"""
    for source_id, observed_at, text in db.execute(sql):
        if len(text) < 60:
            continue
        category = "conversation_long" if len(text) >= 1800 else "conversation_short"
        candidate = item(category, text, "graph:" + digest(source_id), observed_at)
        candidate["aliases"] = source_aliases[source_id]
        yield candidate
        if DATE.search(text) or NEGATION.search(text):
            candidate = item("temporal", text, "graph:" + digest(source_id), observed_at)
            candidate["aliases"] = source_aliases[source_id]
            yield candidate
    for node_id, statement in db.execute("SELECT node_id,statement FROM memory_claims ORDER BY node_id"):
        if statement and len(statement) >= 35:
            candidate = item("learned", statement, "claim:" + digest(node_id))
            candidate["aliases"] = node_aliases[node_id]
            yield candidate
    db.close()


def web_items(root):
    for path in sorted((root / "transcripts").glob("*.jsonl")):
        with path.open(errors="replace") as lines:
            for line in lines:
                if '"web_search"' not in line or '"tool_result"' not in line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = event.get("payload") or {}
                if event.get("kind") != "tool_result" or payload.get("name") != "web_search":
                    continue
                result = payload.get("result") or {}
                for found in result.get("results", []):
                    if not isinstance(found, dict) or len(found.get("snippet", "")) < 35:
                        continue
                    text = " ".join(str(found.get(key, "")) for key in ("title", "snippet", "url"))
                    yield item("web", text, "web:" + digest(path.name + text), event.get("timestamp", ""))


def transcript_items(root):
    for path in sorted((root / "transcripts").glob("*.jsonl")):
        with path.open(errors="replace") as lines:
            for line in lines:
                if '"outbound"' not in line and '"inbound"' not in line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("kind") not in ("inbound", "outbound"):
                    continue
                message = (event.get("payload") or {}).get("message") or {}
                text = message.get("text", "") if isinstance(message, dict) else ""
                if not isinstance(text, str) or len(text) < 60:
                    continue
                source = "transcript:" + digest(path.name + str(event.get("eventId", "")))
                category = "conversation_long" if len(text) >= 1800 else "conversation_short"
                yield item(category, text, source, event.get("timestamp", ""))
                if DATE.search(text) or NEGATION.search(text):
                    yield item("temporal", text, source, event.get("timestamp", ""))


def project_items(root):
    ledger = root / "project-ledger/projects/butler"
    for folder in ("specs", "plans", "decisions", "reports"):
        for path in sorted((ledger / folder).rglob("*.md")):
            if path.stat().st_size > 200_000:
                continue
            text = path.read_text(errors="replace")
            if len(text) >= 100:
                candidate = item("project", text, "ledger:" + digest(str(path.relative_to(ledger))))
                candidate["subtype"] = folder
                yield candidate


def choose(candidates):
    selected = {category: [] for category in CATEGORIES}
    seen = set()
    groups = {category: list() for category in CATEGORIES}
    for candidate in candidates:
        groups[candidate["category"]].append(candidate)
    for category in CATEGORIES:
        quotas = ({"ko": 15, "mixed": 20, "en": 15}
                  if category in ("conversation_short", "conversation_long", "learned", "temporal")
                  else {"specs": 15, "plans": 15, "decisions": 10, "reports": 10}
                  if category == "project" else {"en": 25, "mixed": 25})
        field = "subtype" if category == "project" else "language"
        for value, count in quotas.items():
            for candidate in groups[category]:
                if count == 0:
                    break
                fingerprint = digest(candidate["text"])
                if (candidate.get(field) != value or fingerprint in seen
                        or len(WORD.findall(candidate["text"])) < 10):
                    continue
                seen.add(fingerprint)
                selected[category].append(candidate)
                count -= 1
        for candidate in groups[category]:
            if len(selected[category]) >= LIMIT:
                break
            fingerprint = digest(candidate["text"])
            if fingerprint not in seen and len(WORD.findall(candidate["text"])) >= 10:
                seen.add(fingerprint)
                selected[category].append(candidate)
    missing = {key: LIMIT - len(value) for key, value in selected.items() if len(value) < LIMIT}
    if missing:
        raise ValueError(f"insufficient real items: {missing}")
    return [candidate for category in CATEGORIES for candidate in selected[category]]


def question(candidate, index):
    text = candidate["text"]
    sentences = [segment.strip() for segment in re.split(r"(?<=[.!?。])\s+|\n+", text) if len(segment.strip()) >= 45]
    if not sentences:
        sentences = [text]
    sentence = sentences[len(sentences) // 2] if candidate["category"] == "conversation_long" else sentences[0]
    matches = list(WORD.finditer(sentence))
    if len(matches) < 10:
        sentence = text
        matches = list(WORD.finditer(sentence))
    if len(matches) < 10:
        return None
    tokens = [match.group() for match in matches]
    cue = sentence[matches[0].start():matches[5].end()]
    answer = sentence[matches[6].start():matches[9].end()]
    modes = ("context", "keyword", "ko_wrapper", "two_anchor", "dated", "specific")
    mode = modes[index % len(modes)]
    prompts = {
        "context": f"What did the stored source say about {cue}?",
        "keyword": f"Find the source for {cue}.",
        "ko_wrapper": f"{cue}에 관한 기록의 근거는 무엇인가요?",
        "two_anchor": f"Which source connects {tokens[0]} with {tokens[5]}?",
        "dated": f"As of {candidate['observed_at'][:10] or 'the recorded date'}, what was recorded about {cue}?",
        "specific": f"Which record specifically mentions {cue}?",
    }
    return {"id": f"q{index:03d}", "category": candidate["category"], "mode": mode,
            "text": prompts[mode], "gold_source_ids": [candidate["id"]], "gold_answer": answer,
            "gold_answer_in_source": answer in text}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner-data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.owner_data.resolve()
    candidates = (*graph_items(root), *transcript_items(root), *web_items(root), *project_items(root))
    documents = choose(candidates)
    queries = [question(document, index) for index, document in enumerate(documents)]
    if any(query is None or not query["gold_answer_in_source"] for query in queries):
        raise ValueError("gold answer verification failed")
    data = {"schema": "butler.memory-recall-eval.v1", "documents": documents, "queries": queries}
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.output.write_text(json.dumps(data, ensure_ascii=False))
    args.output.chmod(0o600)
    print(json.dumps({"documents": len(documents), "queries": len(queries),
                      "categories": dict(Counter(doc["category"] for doc in documents))}))


if __name__ == "__main__":
    main()
