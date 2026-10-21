CREATE TABLE IF NOT EXISTS wm_plans (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_on TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private','canon')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by))
);

CREATE TABLE IF NOT EXISTS wm_work_chains (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  graph_revision INTEGER NOT NULL DEFAULT 0 CHECK (graph_revision >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','held','done'))
);

CREATE TABLE IF NOT EXISTS wm_works (
  id TEXT PRIMARY KEY NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session','project')),
  scope_ref TEXT NOT NULL,
  plan_id TEXT REFERENCES wm_plans(id),
  home_session_id TEXT,
  spec_node_id TEXT REFERENCES wm_spec_nodes(node_id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT,
  run_state TEXT NOT NULL DEFAULT 'idle' CHECK (run_state IN ('idle','waiting','held','running','in_review','blocked','failed','paused','stopped','done','cancelled')),
  canon_status TEXT CHECK (canon_status IN ('planned','in_progress','in_review','blocked','done','cancelled')),
  canon_status_source TEXT CHECK (canon_status_source IN ('runtime','person')),
  assignee TEXT,
  plan_rank TEXT CHECK (plan_rank IS NULL OR (length(plan_rank)>0 AND plan_rank NOT GLOB '*[^0-9A-Za-z]*' AND plan_rank NOT GLOB '*0')),
  chain_id TEXT REFERENCES wm_work_chains(id),
  step_index INTEGER CHECK (step_index >= 0),
  stack_position INTEGER CHECK (stack_position >= 0),
  hold_reason TEXT CHECK (hold_reason IN ('predecessor_failed','predecessor_stopped')),
  held_by_work_id TEXT REFERENCES wm_works(id),
  failure_reason TEXT,
  result_reported_at INTEGER,
  queue_origin TEXT CHECK (queue_origin IN ('user_message','schedule','detach')),
  origin_message_id TEXT,
  draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0,1)),
  tier INTEGER NOT NULL DEFAULT 1 CHECK (tier IN (1,2)),
  visibility TEXT NOT NULL CHECK (visibility IN ('private','canon')),
  origin TEXT NOT NULL CHECK (origin IN ('chat','dialog','board','mcp','migration')),
  import_note TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  UNIQUE (id, chain_id),
  CHECK ((chain_id IS NULL AND step_index IS NULL AND stack_position IS NULL) OR (chain_id IS NOT NULL AND step_index IS NOT NULL AND stack_position IS NOT NULL)),
  CHECK (visibility='canon' OR (canon_status IS NULL AND canon_status_source IS NULL)),
  CHECK ((run_state='held') = (hold_reason IS NOT NULL)),
  CHECK ((run_state='held') = (held_by_work_id IS NOT NULL)),
  CHECK ((run_state='failed') = (failure_reason IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS wm_work_edges (
  pred_work_id TEXT NOT NULL,
  succ_work_id TEXT NOT NULL,
  chain_id TEXT NOT NULL REFERENCES wm_work_chains(id),
  PRIMARY KEY (pred_work_id, succ_work_id),
  FOREIGN KEY (pred_work_id,chain_id) REFERENCES wm_works(id,chain_id),
  FOREIGN KEY (succ_work_id,chain_id) REFERENCES wm_works(id,chain_id),
  CHECK (pred_work_id != succ_work_id)
);

CREATE TABLE IF NOT EXISTS wm_hold_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  chain_id TEXT NOT NULL REFERENCES wm_work_chains(id),
  failed_work_id TEXT NOT NULL REFERENCES wm_works(id),
  held_step_index INTEGER NOT NULL CHECK (held_step_index >= 0),
  question_message_id TEXT NOT NULL,
  decision TEXT CHECK (decision IN ('run_anyway','delete')),
  decided_at INTEGER,
  CHECK ((decision IS NULL) = (decided_at IS NULL))
);
