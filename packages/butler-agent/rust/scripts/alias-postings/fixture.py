"""Deterministic synthetic data. Never opens a Butler data directory."""

import hashlib
import random
import re
import uuid

NODES = 14_293
ALIASES = 16_561
POSTINGS = 886_340


def grams(text):
    # Fixture alphabet consists only of single-codepoint graphemes already folded.
    return sorted({text[i:i + n] for n in (2, 3) for i in range(len(text) - n + 1)})


def generate():
    rng = random.Random(435)
    alphabet = "abcdefghijklmnopqrstuvwxyz" + "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허"
    nodes = [str(uuid.UUID(bytes=hashlib.md5(f"node-{i}".encode()).digest()))
             for i in range(NODES)]
    aliases = []
    for i in range(ALIASES):
        target = 54 if i < POSTINGS - ALIASES * 53 else 53
        while True:
            # Repeated motifs model long aliases with ~54 distinct 2/3-grams.
            motif = "".join(rng.choice(alphabet) for _ in range(27))
            surface = (motif * 4)[:83]
            parts = grams(surface)
            if len(parts) == target:
                break
        source = hashlib.sha256(f"source-{i}".encode()).hexdigest()
        aliases.append((nodes[i % NODES], source, surface, parts))
    assert len(aliases) == ALIASES
    assert sum(len(a[3]) for a in aliases) == POSTINGS
    assert all(len(a[2]) == 83 for a in aliases)
    return nodes, aliases


def seed_graph(db, root, nodes, aliases):
    schema = (root / "crates/butler-memory/src/cognition/graph/schema/base.rs").read_text()
    tables = ("memory_chunks", "memory_chunk_sources", "memory_nodes", "memory_aliases",
              "memory_claims")
    for name in tables:
        db.execute(re.search(rf"CREATE TABLE IF NOT EXISTS {name}\(.*?;", schema).group())
    db.executescript("CREATE INDEX idx_alias_folded ON memory_aliases(folded_key,node_id);"
                     "CREATE INDEX idx_alias_nfc ON memory_aliases(nfc_key,node_id);")
    for i, node in enumerate(nodes):
        kind = "preference" if i % 5 == 0 else "entity"
        db.execute("INSERT INTO memory_nodes VALUES(?,?,?,?,?,?,?)",
                   (node, kind, "synthetic", "project" if i % 3 == 0 else "global",
                    f"project-{i % 4}" if i % 3 == 0 else None, None, "2026-01-01"))
        if kind == "preference":
            db.execute("INSERT INTO memory_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                       (node, "synthetic", "assert", "user_statement", "positive", None,
                        None, "2026-01-01", "2026-09-01" if i % 7 == 0 else None,
                        "normal", "user", "model_interpretation",))
    for i, (node, source, surface, _) in enumerate(aliases):
        project = f"project-{i % 4}" if i % 3 == 0 else None
        chunk = f"episode-{i}"
        db.execute("INSERT INTO memory_chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (chunk, chunk, "1", f"session-{i % 8}", None, None, None, project,
                    "user_input", "inactive" if i % 11 == 0 else "active", "", "pending",
                    source, "2026-01-01", "2026-01-01"))
        origin = "internal_control" if i % 13 == 0 else "user_input"
        db.execute("INSERT INTO memory_chunk_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (source, chunk, "0" if i % 17 == 0 else "1", "conversation",
                    f"session-{i % 8}", None, "text", "/text", 0, 83, source, "user",
                    origin, "2026-11-01" if i % 19 == 0 else "2026-01-01", "user_statement"))
        db.execute("INSERT INTO memory_aliases VALUES(?,?,?,?,?,?,?)",
                   (node, surface, surface, surface, "[]", source, "literal"))
    db.commit()


def eligibility(aliases, nodes, mode):
    """Independent oracle, including inactive/revised/internal/future/expired rows."""
    node_ord = {node: i for i, node in enumerate(nodes)}
    out = []
    for i, alias in enumerate(aliases):
        n = node_ord[alias[0]]
        if any(i % divisor == 0 for divisor in (11, 17, 19)):
            continue
        if mode != "internal" and i % 13 == 0:
            continue
        if n % 5 == 0 and n % 7 == 0:
            continue
        project = f"project-{i % 4}" if i % 3 == 0 else None
        if mode == "project" and project != "project-0":
            continue
        if mode == "session" and i % 8 != 0:
            continue
        if mode == "registration" and project not in (None, "project-0"):
            continue
        out.append(alias)
    return out
