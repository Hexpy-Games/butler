CREATE TABLE IF NOT EXISTS canon_tags (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32 AND name = trim(name)),
  name_key TEXT NOT NULL,
  color TEXT NOT NULL CHECK (color IN ('gray','red','orange','yellow','green','teal','blue','purple')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  UNIQUE (project_id,name_key)
);
CREATE TABLE IF NOT EXISTS canon_epic_tags (
  epic_id TEXT NOT NULL REFERENCES canon_epics(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES canon_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (epic_id,tag_id)
);
CREATE INDEX IF NOT EXISTS canon_epic_tags_tag ON canon_epic_tags(tag_id,epic_id);
