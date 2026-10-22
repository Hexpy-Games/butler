CREATE TABLE IF NOT EXISTS wm_task_chains (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL REFERENCES wm_works(id),
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','held','done')),
  UNIQUE (work_id,id)
);

CREATE TABLE IF NOT EXISTS wm_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL REFERENCES wm_works(id),
  spec_ref TEXT NOT NULL CHECK (json_valid(spec_ref)),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','waiting','pending','running','in_review','held','failed','completed','blocked','paused','stopped','cancelled')),
  assignee_session_id TEXT,
  blocked_reason TEXT,
  supersedes_task_id TEXT REFERENCES wm_tasks(id),
  completion_revision INTEGER,
  chain_id TEXT,
  step_index INTEGER CHECK (step_index >= 0),
  stack_position INTEGER CHECK (stack_position >= 0),
  hold_reason TEXT CHECK (hold_reason IN ('predecessor_failed','predecessor_stopped')),
  held_by_task_id TEXT REFERENCES wm_tasks(id),
  failure_reason TEXT,
  result_reported_at INTEGER,
  origin TEXT NOT NULL CHECK (origin IN ('user_message','schedule','detach','planner','migration')),
  origin_message_id TEXT,
  historical INTEGER NOT NULL DEFAULT 0 CHECK (historical IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  UNIQUE (work_id,id),
  UNIQUE (id,chain_id),
  FOREIGN KEY (work_id,chain_id) REFERENCES wm_task_chains(work_id,id),
  CHECK ((chain_id IS NULL AND step_index IS NULL AND stack_position IS NULL) OR (chain_id IS NOT NULL AND step_index IS NOT NULL AND stack_position IS NOT NULL)),
  CHECK (status='cancelled' OR chain_id IS NOT NULL),
  CHECK ((status='held') = (hold_reason IS NOT NULL)),
  CHECK ((status='held') = (held_by_task_id IS NOT NULL)),
  CHECK ((status='failed') = (failure_reason IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS wm_task_edges (
  work_id TEXT NOT NULL REFERENCES wm_works(id),
  chain_id TEXT NOT NULL REFERENCES wm_task_chains(id),
  pred TEXT NOT NULL,
  succ TEXT NOT NULL,
  PRIMARY KEY (work_id,pred,succ),
  FOREIGN KEY (work_id,pred) REFERENCES wm_tasks(work_id,id),
  FOREIGN KEY (work_id,succ) REFERENCES wm_tasks(work_id,id),
  FOREIGN KEY (pred,chain_id) REFERENCES wm_tasks(id,chain_id),
  FOREIGN KEY (succ,chain_id) REFERENCES wm_tasks(id,chain_id),
  CHECK (pred != succ)
);

CREATE TABLE IF NOT EXISTS wm_task_criteria (
  task_id TEXT NOT NULL REFERENCES wm_tasks(id),
  node_id TEXT NOT NULL,
  node_revision INTEGER NOT NULL,
  criterion_id TEXT NOT NULL,
  PRIMARY KEY (task_id,node_id,node_revision,criterion_id),
  FOREIGN KEY (node_id,node_revision,criterion_id) REFERENCES wm_spec_criteria(node_id,revision,criterion_id)
);

CREATE TABLE IF NOT EXISTS wm_task_hold_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  chain_id TEXT NOT NULL REFERENCES wm_task_chains(id),
  failed_task_id TEXT NOT NULL REFERENCES wm_tasks(id),
  held_step_index INTEGER NOT NULL CHECK (held_step_index >= 0),
  question_message_id TEXT NOT NULL,
  coverage_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(coverage_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  decision TEXT CHECK (decision IN ('run_anyway','delete')),
  decided_at INTEGER,
  resolved_at INTEGER,
  CHECK ((decision IS NULL) = (decided_at IS NULL))
);


CREATE TABLE IF NOT EXISTS wm_task_parts (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES wm_tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('execute','integrate','review')),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','awaiting_review','completed','failed','cancelled')),
  part_rank TEXT NOT NULL,
  assignee_session_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  UNIQUE (task_id,id)
);
CREATE TABLE IF NOT EXISTS wm_task_part_edges (
  task_id TEXT NOT NULL REFERENCES wm_tasks(id),
  pred TEXT NOT NULL,
  succ TEXT NOT NULL,
  PRIMARY KEY (task_id,pred,succ),
  FOREIGN KEY (task_id,pred) REFERENCES wm_task_parts(task_id,id),
  FOREIGN KEY (task_id,succ) REFERENCES wm_task_parts(task_id,id),
  CHECK (pred != succ)
);

CREATE TABLE IF NOT EXISTS wm_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES wm_tasks(id),
  part_id TEXT REFERENCES wm_task_parts(id),
  task_revision INTEGER NOT NULL,
  spec_ref TEXT NOT NULL CHECK (json_valid(spec_ref)),
  session_id TEXT NOT NULL,
  turn_id TEXT,
  lease_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted')),
  checkpoint_ref TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  recovered_at INTEGER
);

CREATE TABLE IF NOT EXISTS wm_results (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  task_id TEXT NOT NULL REFERENCES wm_tasks(id),
  task_revision INTEGER NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES wm_attempts(id),
  spec_ref TEXT NOT NULL CHECK (json_valid(spec_ref)),
  body_ref TEXT NOT NULL,
  criterion_results_json TEXT NOT NULL CHECK (json_valid(criterion_results_json) AND json_type(criterion_results_json)='array'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id,revision)
);

CREATE TABLE IF NOT EXISTS wm_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES wm_tasks(id),
  task_revision INTEGER NOT NULL,
  spec_ref TEXT NOT NULL CHECK (json_valid(spec_ref)),
  result_id TEXT NOT NULL,
  result_revision INTEGER NOT NULL,
  reviewer TEXT NOT NULL CHECK (json_valid(reviewer)),
  criterion_results_json TEXT NOT NULL CHECK (json_valid(criterion_results_json) AND json_type(criterion_results_json)='array'),
  verdict TEXT NOT NULL CHECK (verdict IN ('accepted','rejected')),
  at INTEGER NOT NULL,
  FOREIGN KEY (result_id,result_revision) REFERENCES wm_results(id,revision)
);
