"""Independent levers plus a normalized alias-document prototype."""

VARIANTS = ("baseline", "without_rowid", "drop_redundant", "surface_once",
            "integers", "compact", "compact_native", "fts5_trigram", "fts5_hybrid")

INDEXES = {
    "gram_source": "gram,node_id,source_id",
    "entity": "node_id,gram,source_id,surface_original",
    "alias": "node_id,source_id,surface_original,gram",
    "scope_gram_node": "identity_scope,project_id,gram,node_id",
}


def install(db, variant):
    normalized = variant in ("surface_once", "integers", "compact", "fts5_trigram", "fts5_hybrid")
    if normalized:
        db.execute("CREATE TABLE alias_docs(id INTEGER PRIMARY KEY,node_id TEXT NOT NULL,"
                   "source_id TEXT NOT NULL,surface_original TEXT NOT NULL,"
                   "UNIQUE(node_id,source_id,surface_original))")
    if variant in ("compact", "fts5_trigram", "fts5_hybrid"):
        if variant != "fts5_trigram":
            db.executescript("CREATE TABLE compact_postings(gram TEXT NOT NULL,alias_id INTEGER NOT NULL "
                             "REFERENCES alias_docs(id),PRIMARY KEY(gram,alias_id)) WITHOUT ROWID;"
                             "CREATE INDEX compact_by_alias ON compact_postings(alias_id);")
        if variant.startswith("fts5"):
            db.executescript("CREATE VIRTUAL TABLE alias_fts USING fts5(surface_original,"
                             "content='alias_docs',content_rowid='id',tokenize='trigram');"
                             "CREATE VIRTUAL TABLE alias_vocab USING fts5vocab(alias_fts,'instance');")
        relation = "SELECT gram,alias_id FROM compact_postings"
        if variant.startswith("fts5"):
            relation = "SELECT DISTINCT term AS gram,doc AS alias_id FROM alias_vocab"
            if variant == "fts5_hybrid":
                relation += " UNION ALL SELECT gram,alias_id FROM compact_postings"
        db.execute("CREATE VIEW memory_alias_postings AS SELECT p.gram,a.node_id,a.source_id,"
                   "a.surface_original FROM (" + relation + ") p JOIN alias_docs a ON a.id=p.alias_id")
        return
    integer = variant == "integers"
    if integer:
        db.executescript("CREATE TABLE node_keys(id INTEGER PRIMARY KEY,text_id TEXT NOT NULL UNIQUE);"
                         "CREATE TABLE source_keys(id INTEGER PRIMARY KEY,text_id TEXT NOT NULL UNIQUE);")
    key_type = "INTEGER" if integer else "TEXT"
    surface_type = "INTEGER" if normalized else "TEXT"
    db.execute(f"CREATE TABLE postings(gram TEXT NOT NULL,node_id {key_type} NOT NULL,"
               f"source_id {key_type} NOT NULL,surface_original {surface_type} NOT NULL,"
               "identity_scope TEXT NOT NULL,project_id TEXT,"
               "PRIMARY KEY(gram,node_id,source_id,surface_original))"
               + (" WITHOUT ROWID" if variant == "without_rowid" else ""))
    for name, columns in INDEXES.items():
        if variant == "drop_redundant" and name in ("gram_source", "entity"):
            continue
        db.execute(f"CREATE INDEX idx_alias_postings_{name} ON postings({columns})")
    if integer:
        relation = ("SELECT p.gram,n.text_id node_id,s.text_id source_id,a.surface_original "
                    "FROM postings p JOIN node_keys n ON n.id=p.node_id "
                    "JOIN source_keys s ON s.id=p.source_id JOIN alias_docs a ON a.id=p.surface_original")
    elif normalized:
        relation = ("SELECT p.gram,p.node_id,p.source_id,a.surface_original "
                    "FROM postings p JOIN alias_docs a ON a.id=p.surface_original")
    else:
        relation = "SELECT * FROM postings"
    db.execute("CREATE VIEW memory_alias_postings AS " + relation)


def insert_alias(db, variant, ordinal, alias):
    node, source, surface, parts = alias
    normalized = variant in ("surface_once", "integers", "compact", "fts5_trigram", "fts5_hybrid")
    if normalized:
        db.execute("INSERT INTO alias_docs VALUES(?,?,?,?)", (ordinal, node, source, surface))
    if variant.startswith("fts5"):
        db.execute("INSERT INTO alias_fts(rowid,surface_original) VALUES(?,?)", (ordinal, surface))
        if variant == "fts5_trigram":
            return
        parts = [g for g in parts if len(g) == 2]
    if variant in ("compact", "fts5_hybrid"):
        db.executemany("INSERT INTO compact_postings VALUES(?,?)", [(g, ordinal) for g in parts])
        return
    if variant == "integers":
        db.execute("INSERT OR IGNORE INTO node_keys(text_id) VALUES(?)", (node,))
        db.execute("INSERT OR IGNORE INTO source_keys(text_id) VALUES(?)", (source,))
        node = db.execute("SELECT id FROM node_keys WHERE text_id=?", (node,)).fetchone()[0]
        source = db.execute("SELECT id FROM source_keys WHERE text_id=?", (source,)).fetchone()[0]
    # Scope derived from the node, not the source: match production indexing.
    scope, project = db.execute("SELECT identity_scope,project_id FROM memory_nodes WHERE id=?",
                               (alias[0],)).fetchone()
    db.executemany("INSERT INTO postings VALUES(?,?,?,?,?,?)",
                   [(g, node, source, ordinal if normalized else surface, scope, project) for g in parts])


def write_plans(db, variant):
    statements = {}
    if variant in ("compact", "compact_native", "fts5_hybrid"):
        statements["delete_grams"] = ("DELETE FROM compact_postings WHERE alias_id=?", (1,))
    elif variant != "fts5_trigram":
        statements["delete_grams"] = (
            "DELETE FROM postings WHERE node_id=? AND source_id=? AND surface_original=?",
            (1, 1, 1) if variant == "integers" else ("node", "source", 1 if variant == "surface_once" else "surface"))
    if variant not in ("baseline", "without_rowid", "drop_redundant"):
        statements["alias_lookup"] = ("SELECT id FROM alias_docs WHERE node_id=? AND source_id=? "
                                      "AND surface_original=?", ("node", "source", "surface"))
    return {name: {"sql": sql, "plan": [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql, binds)]}
            for name, (sql, binds) in statements.items()}
