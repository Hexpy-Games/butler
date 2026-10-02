"""Load the four production statements; substitute only scope and JSON binds."""

import re

PREFIX = "crates/butler-memory/src/cognition/graph/"


def rust_string(path, start):
    text = path.read_text()
    offset = text.index(start)
    end = text.index('"', offset)
    return re.sub(r"\\\n\s*", "", text[offset:end]), text[:offset].count("\n") + 1


def load(root):
    selection = root / (PREFIX + "candidates/selection.rs")
    lexical = root / (PREFIX + "recall/semantic/lexical.rs")
    eligible, _ = rust_string(selection, "c.status='active'")
    starts = (
        (selection, "registration.postings", "SELECT DISTINCT p.node_id"),
        (selection, "registration.frequencies", "WITH eligible AS MATERIALIZED"),
        (lexical, "recall.postings", "SELECT DISTINCT p.node_id"),
        (lexical, "recall.frequencies", "WITH eligible AS MATERIALIZED"),
    )
    return [(name, *rust_string(path, start), str(path.relative_to(root)), eligible)
            for path, name, start in starts]


def bind(query, mode, grams_json):
    name, sql, line, path, eligible = query
    if name.startswith("registration"):
        return sql.replace("{ELIGIBLE}", eligible), ("project-0", "2026-10-02", grams_json)
    claim = ("(e.type NOT IN ('preference','goal','constraint','decision','memory_atom') OR "
             "(((SELECT valid_from FROM memory_claims WHERE node_id=e.id) IS NULL OR "
             "julianday((SELECT valid_from FROM memory_claims WHERE node_id=e.id))<=julianday(?)) "
             "AND ((SELECT valid_to FROM memory_claims WHERE node_id=e.id) IS NULL OR "
             "julianday((SELECT valid_to FROM memory_claims WHERE node_id=e.id))>julianday(?))))")
    origins = "'user_input','assistant_public'"
    if mode == "internal":
        origins += ",'unknown','internal_control'"
    source = (f"c.status='active' AND ((s.source_kind='conversation' AND s.origin_kind IN ({origins})) "
              "OR (s.source_kind='task_report' AND s.role='task' AND s.basis='reviewed_task') "
              "OR (s.source_kind='explicit_record' AND s.role='explicit' AND s.basis='user_statement'))")
    args = ["2026-10-02", "2026-10-02"]
    if mode == "project":
        source += " AND c.project_id=?"
        args.append("project-0")
    if mode == "session":
        source += " AND c.conversation_session_id=?"
        args.append("session-0")
    source += " AND julianday(s.observed_at)<=julianday(?)"
    args.append("2026-10-02")
    sql = sql.replace("{ALIAS_JOIN}", "JOIN memory_nodes e ON e.id=a.node_id "
                      "JOIN memory_chunk_sources s ON s.source_id=a.source_id "
                      "JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision")
    sql = sql.replace("{}", claim, 1).replace("{}", source, 1)
    args = [grams_json, *args] if name.endswith("postings") else [*args, grams_json]
    return sql, args


def alias_id_frequencies(sql):
    """Same corpus and counts; resolve eligible alias IDs once, before gram probes."""
    sql, changed = re.subn(r"SELECT DISTINCT a.node_id,a.source_id FROM memory_aliases a",
                          "SELECT DISTINCT a.id FROM alias_docs a", sql)
    assert changed == 1
    sql = sql.replace("FROM memory_alias_postings p", "FROM compact_postings p")
    sql = sql.replace("d.node_id=p.node_id AND d.source_id=p.source_id", "d.id=p.alias_id")
    return sql
