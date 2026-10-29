CREATE TABLE IF NOT EXISTS canon_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  op TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);

CREATE TABLE IF NOT EXISTS canon_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS canon_counters (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session','project')),
  scope_ref TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (scope_kind,scope_ref,key)
);

CREATE TRIGGER IF NOT EXISTS canon_audit_no_update BEFORE UPDATE ON canon_audit
BEGIN SELECT RAISE(ABORT, 'immutable canon history'); END;
CREATE TRIGGER IF NOT EXISTS canon_audit_no_delete BEFORE DELETE ON canon_audit
BEGIN SELECT RAISE(ABORT, 'immutable canon history'); END;
CREATE TRIGGER IF NOT EXISTS canon_spec_bodies_no_update BEFORE UPDATE ON canon_spec_bodies
BEGIN SELECT RAISE(ABORT, 'immutable canon history'); END;
CREATE TRIGGER IF NOT EXISTS canon_spec_bodies_no_delete BEFORE DELETE ON canon_spec_bodies
BEGIN SELECT RAISE(ABORT, 'immutable canon history'); END;
CREATE TRIGGER IF NOT EXISTS canon_spec_criteria_no_update BEFORE UPDATE ON canon_spec_criteria
BEGIN SELECT RAISE(ABORT, 'immutable canon history'); END;
CREATE TRIGGER IF NOT EXISTS canon_spec_criteria_no_delete BEFORE DELETE ON canon_spec_criteria
BEGIN SELECT RAISE(ABORT, 'immutable canon history'); END;
CREATE TRIGGER IF NOT EXISTS canon_spec_revisions_no_content_update
BEFORE UPDATE OF node_id,revision,body_hash,parser_version ON canon_spec_revisions
BEGIN SELECT RAISE(ABORT, 'immutable spec revision content'); END;
CREATE TRIGGER IF NOT EXISTS canon_spec_revisions_no_delete BEFORE DELETE ON canon_spec_revisions
BEGIN SELECT RAISE(ABORT, 'immutable spec revision'); END;
CREATE TABLE IF NOT EXISTS canon_intents (
  op_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','applied')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS canon_cursors (
  name TEXT PRIMARY KEY NOT NULL CHECK (name IN ('progress_feed','link_reconcile')),
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS canon_session_epics (
  session_id TEXT NOT NULL,
  epic_id TEXT NOT NULL REFERENCES canon_epics(id),
  is_home INTEGER NOT NULL DEFAULT 0 CHECK(is_home IN (0,1)),
  bound_at INTEGER NOT NULL,
  bound_by TEXT NOT NULL CHECK (json_valid(bound_by)),
  origin TEXT NOT NULL CHECK (origin IN ('user','butler')),
  PRIMARY KEY (session_id,epic_id)
);
CREATE INDEX IF NOT EXISTS canon_session_epics_epic ON canon_session_epics(epic_id,bound_at,session_id);
CREATE INDEX IF NOT EXISTS canon_session_epics_session ON canon_session_epics(session_id,bound_at,epic_id);
CREATE TABLE IF NOT EXISTS canon_epic_work_links (
  epic_id TEXT NOT NULL REFERENCES canon_epics(id),
  btcc_work_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  reported_applied INTEGER NOT NULL DEFAULT 0 CHECK (reported_applied IN (0,1)),
  linked_by TEXT NOT NULL CHECK (json_valid(linked_by)),
  PRIMARY KEY (epic_id,btcc_work_id)
);
CREATE INDEX IF NOT EXISTS canon_epic_work_links_epic ON canon_epic_work_links(epic_id,linked_at);
CREATE INDEX IF NOT EXISTS canon_epic_work_links_session ON canon_epic_work_links(session_id);
