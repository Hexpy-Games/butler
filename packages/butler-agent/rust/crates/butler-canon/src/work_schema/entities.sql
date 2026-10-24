CREATE TABLE IF NOT EXISTS canon_plans (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_on TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by))
);

CREATE TABLE IF NOT EXISTS canon_epics (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  plan_id TEXT REFERENCES canon_plans(id),
  spec_node_id TEXT REFERENCES canon_spec_nodes(node_id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT,
  canon_status TEXT DEFAULT 'planned' CHECK (canon_status IN ('planned','in_progress','in_review','blocked','done','cancelled')),
  canon_status_source TEXT DEFAULT 'person' CHECK (canon_status_source IN ('runtime','person')),
  assignee TEXT,
  plan_rank TEXT CHECK (plan_rank IS NULL OR (length(plan_rank)>0 AND plan_rank NOT GLOB '*[^0-9A-Za-z]*' AND plan_rank NOT GLOB '*0')),
  origin TEXT NOT NULL CHECK (origin IN ('chat','dialog','board','mcp')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by))
);
