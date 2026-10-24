pub(super) const COLUMNS: &[(&str, &str, &str)] = &[
    (
        "canon_epics",
        "canon_status",
        "'planned','in_progress','in_review','blocked','done','cancelled'",
    ),
    ("canon_epics", "canon_status_source", "'runtime','person'"),
    ("canon_epics", "origin", "'chat','dialog','board','mcp'"),
    ("canon_plans", "status", "'open','closed'"),
    ("canon_spec_nodes", "scope_kind", "'session','project'"),
    ("canon_spec_nodes", "visibility", "'private','canon'"),
    (
        "canon_spec_nodes",
        "lifecycle",
        "'draft','active','retired'",
    ),
    ("canon_spec_nodes", "source", "'local','repo'"),
    (
        "canon_spec_revisions",
        "state",
        "'published','active','inactive'",
    ),
    ("canon_intents", "state", "'pending','applied'"),
    ("canon_counters", "scope_kind", "'session','project'"),
    ("canon_session_epics", "origin", "'user','butler'"),
];
