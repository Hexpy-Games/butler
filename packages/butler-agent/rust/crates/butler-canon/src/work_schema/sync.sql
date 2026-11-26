CREATE TABLE IF NOT EXISTS canon_space_links (
  project_id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  cursor_seq INTEGER NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
  state TEXT NOT NULL CHECK (state IN ('linked','detached')),
  resync_pending INTEGER NOT NULL DEFAULT 0 CHECK (resync_pending IN (0,1)),
  linked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS canon_sync_entities (
  entity_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plan','epic','tag','epic_tag','comment')),
  local_key TEXT NOT NULL,
  parent_id TEXT,
  sync_revision INTEGER NOT NULL DEFAULT 0 CHECK (sync_revision >= 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  UNIQUE (kind, local_key)
);
CREATE INDEX IF NOT EXISTS canon_sync_entities_project ON canon_sync_entities(project_id, kind);
CREATE INDEX IF NOT EXISTS canon_sync_entities_parent ON canon_sync_entities(parent_id, kind) WHERE parent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS canon_sync_outbox (
  seq INTEGER PRIMARY KEY,
  op_id TEXT NOT NULL UNIQUE,
  space_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','set','move','delete','append')),
  base_revision INTEGER,
  fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
  acked_seq INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS canon_sync_outbox_space ON canon_sync_outbox(space_id);
CREATE INDEX IF NOT EXISTS canon_sync_outbox_entity ON canon_sync_outbox(entity_id);
