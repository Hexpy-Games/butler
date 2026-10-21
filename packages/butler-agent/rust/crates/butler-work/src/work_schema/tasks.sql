CREATE TABLE IF NOT EXISTS wm_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL REFERENCES wm_works(id),
  spec_ref TEXT NOT NULL CHECK (json_valid(spec_ref)),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('execute','integrate','review')),
  status TEXT NOT NULL CHECK (status IN ('draft','pending','running','awaiting_review','completed','blocked','paused','stopped','cancelled')),
  task_rank TEXT NOT NULL CHECK (length(task_rank)>0),
  assignee_session_id TEXT,
  blocked_reason TEXT,
  supersedes_task_id TEXT REFERENCES wm_tasks(id),
  completion_revision INTEGER,
  historical INTEGER NOT NULL DEFAULT 0 CHECK (historical IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  UNIQUE (work_id,id)
);

CREATE TABLE IF NOT EXISTS wm_task_edges (
  work_id TEXT NOT NULL REFERENCES wm_works(id),
  pred TEXT NOT NULL,
  succ TEXT NOT NULL,
  PRIMARY KEY (work_id,pred,succ),
  FOREIGN KEY (work_id,pred) REFERENCES wm_tasks(work_id,id),
  FOREIGN KEY (work_id,succ) REFERENCES wm_tasks(work_id,id),
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

CREATE TABLE IF NOT EXISTS wm_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES wm_tasks(id),
  task_revision INTEGER NOT NULL,
  spec_ref TEXT NOT NULL CHECK (json_valid(spec_ref)),
  session_id TEXT NOT NULL,
  turn_id TEXT,
  lease_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted')),
  checkpoint_ref TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
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
