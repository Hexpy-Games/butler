CREATE TABLE IF NOT EXISTS wm_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  op TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);

CREATE TABLE IF NOT EXISTS wm_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wm_counts (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session','project')),
  scope_ref TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (scope_kind,scope_ref,key)
);

CREATE TABLE IF NOT EXISTS wm_legacy_map (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  new_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  imported_revision INTEGER NOT NULL,
  batch TEXT NOT NULL,
  PRIMARY KEY (source,source_id)
);

CREATE TABLE IF NOT EXISTS wm_migration (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  state TEXT NOT NULL CHECK (state IN ('pending','backing_up','failed_backup_copy','failed_backup_worker','importing','needs_source','complete','postponed_no_space')),
  cursor_json TEXT NOT NULL CHECK (json_valid(cursor_json)),
  source_counts_json TEXT NOT NULL CHECK (json_valid(source_counts_json)),
  writer_epoch INTEGER NOT NULL,
  legacy_feed_watermark INTEGER NOT NULL,
  needs_source_json TEXT NOT NULL CHECK (json_valid(needs_source_json))
);

CREATE TRIGGER IF NOT EXISTS wm_audit_no_update BEFORE UPDATE ON wm_audit
BEGIN SELECT RAISE(ABORT, 'immutable work-model history'); END;
CREATE TRIGGER IF NOT EXISTS wm_audit_no_delete BEFORE DELETE ON wm_audit
BEGIN SELECT RAISE(ABORT, 'immutable work-model history'); END;
CREATE TRIGGER IF NOT EXISTS wm_results_no_update BEFORE UPDATE ON wm_results
BEGIN SELECT RAISE(ABORT, 'immutable work-model history'); END;
CREATE TRIGGER IF NOT EXISTS wm_results_no_delete BEFORE DELETE ON wm_results
BEGIN SELECT RAISE(ABORT, 'immutable work-model history'); END;
CREATE TRIGGER IF NOT EXISTS wm_reviews_no_update BEFORE UPDATE ON wm_reviews
BEGIN SELECT RAISE(ABORT, 'immutable work-model history'); END;
CREATE TRIGGER IF NOT EXISTS wm_reviews_no_delete BEFORE DELETE ON wm_reviews
BEGIN SELECT RAISE(ABORT, 'immutable work-model history'); END;
CREATE TRIGGER IF NOT EXISTS wm_spec_bodies_no_update BEFORE UPDATE ON wm_spec_bodies
BEGIN SELECT RAISE(ABORT, 'immutable work-model history'); END;
CREATE TRIGGER IF NOT EXISTS wm_spec_bodies_no_delete BEFORE DELETE ON wm_spec_bodies
BEGIN SELECT RAISE(ABORT, 'immutable work-model history'); END;
CREATE TRIGGER IF NOT EXISTS wm_spec_criteria_no_update BEFORE UPDATE ON wm_spec_criteria
BEGIN SELECT RAISE(ABORT, 'immutable work-model history'); END;
CREATE TRIGGER IF NOT EXISTS wm_spec_criteria_no_delete BEFORE DELETE ON wm_spec_criteria
BEGIN SELECT RAISE(ABORT, 'immutable work-model history'); END;
CREATE TRIGGER IF NOT EXISTS wm_spec_revisions_no_content_update
BEFORE UPDATE OF node_id,revision,body_hash,parser_version,authoring_instruction_id ON wm_spec_revisions
BEGIN SELECT RAISE(ABORT, 'immutable spec revision content'); END;
CREATE TRIGGER IF NOT EXISTS wm_spec_revisions_no_delete BEFORE DELETE ON wm_spec_revisions
BEGIN SELECT RAISE(ABORT, 'immutable spec revision'); END;
