CREATE TABLE IF NOT EXISTS wm_spec_nodes (
  node_id TEXT PRIMARY KEY NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session','project')),
  scope_ref TEXT NOT NULL,
  work_id TEXT REFERENCES wm_works(id),
  parent_node_id TEXT REFERENCES wm_spec_nodes(node_id),
  concern_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private','canon')),
  active_revision INTEGER,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft','active','retired')),
  source TEXT NOT NULL CHECK (source IN ('local','repo')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  FOREIGN KEY (node_id,active_revision) REFERENCES wm_spec_revisions(node_id,revision)
);

CREATE TABLE IF NOT EXISTS wm_spec_bodies (
  hash TEXT PRIMARY KEY NOT NULL,
  body BLOB NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0)
);

CREATE TABLE IF NOT EXISTS wm_spec_revisions (
  node_id TEXT NOT NULL REFERENCES wm_spec_nodes(node_id),
  revision INTEGER NOT NULL,
  body_hash TEXT NOT NULL REFERENCES wm_spec_bodies(hash),
  parser_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('published','active','inactive')),
  authoring_instruction_id TEXT REFERENCES wm_instructions(id),
  PRIMARY KEY (node_id,revision)
);

CREATE TABLE IF NOT EXISTS wm_spec_criteria (
  node_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  criterion_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (node_id,revision,criterion_id),
  FOREIGN KEY (node_id,revision) REFERENCES wm_spec_revisions(node_id,revision)
);
