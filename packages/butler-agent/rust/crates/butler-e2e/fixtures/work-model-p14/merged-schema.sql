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
  run_generation INTEGER NOT NULL DEFAULT 0 CHECK (run_generation >= 0),
  run_state TEXT NOT NULL DEFAULT 'idle' CHECK (run_state IN ('idle','running','in_review','blocked','failed','paused','stopped','done','cancelled')),
  canon_status TEXT CHECK (canon_status IN ('planned','in_progress','in_review','blocked','done','cancelled')),
  canon_status_source TEXT CHECK (canon_status_source IN ('runtime','person')),
  assignee TEXT,
  plan_rank TEXT CHECK (plan_rank IS NULL OR (length(plan_rank)>0 AND plan_rank NOT GLOB '*[^0-9A-Za-z]*' AND plan_rank NOT GLOB '*0')),
  failure_reason TEXT,
  task_graph_revision INTEGER NOT NULL DEFAULT 0 CHECK (task_graph_revision >= 0),
  draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0,1)),
  tier INTEGER NOT NULL DEFAULT 1 CHECK (tier IN (1,2)),
  visibility TEXT NOT NULL CHECK (visibility IN ('private','canon')),
  origin TEXT NOT NULL CHECK (origin IN ('chat','dialog','board','mcp','migration')),
  import_note TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  CHECK (visibility='canon' OR (canon_status IS NULL AND canon_status_source IS NULL)),
  CHECK ((run_state='failed') = (failure_reason IS NOT NULL))
);

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

CREATE TABLE IF NOT EXISTS wm_instructions (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  target_session_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (json_valid(sender)),
  mode TEXT NOT NULL CHECK (mode IN ('queue','steer')),
  body_ref TEXT NOT NULL,
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('turn','task')),
  anchor_id TEXT NOT NULL,
  boundary_seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','waiting_for_turn','waiting_for_task','pending_safe_point','delivered','applied','rejected','needs_input','superseded','cancelled')),
  received_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wm_session_exec (
  session_id TEXT PRIMARY KEY NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (0,1,2)),
  phase TEXT NOT NULL CHECK (phase IN ('conception','planning','execution','review','validation','reporting')),
  control_state TEXT NOT NULL CHECK (control_state IN ('running','pausing','paused','stopping','stopped','reconciling')),
  control_epoch INTEGER NOT NULL,
  current_task_id TEXT REFERENCES wm_tasks(id),
  last_applied_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wm_holds (
  id TEXT PRIMARY KEY NOT NULL,
  target TEXT NOT NULL,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pause','stop')),
  released_at INTEGER
);

CREATE TABLE IF NOT EXISTS wm_cross_db_intents (
  op_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','applied')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wm_runtime_marker (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  boot_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  clean_shutdown_at INTEGER
);

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
  state TEXT NOT NULL CHECK (state IN ('pending','importing','needs_source','complete')),
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

CREATE INDEX IF NOT EXISTS wm_works_scope ON wm_works(scope_kind,scope_ref,visibility,run_state);
CREATE INDEX IF NOT EXISTS wm_works_plan ON wm_works(plan_id,plan_rank) WHERE visibility='canon';
CREATE INDEX IF NOT EXISTS wm_works_backlog ON wm_works(scope_ref,plan_rank) WHERE visibility='canon' AND plan_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wm_works_home ON wm_works(home_session_id) WHERE visibility='canon' AND home_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wm_task_hold_decisions_pending ON wm_task_hold_decisions(chain_id,held_step_index) WHERE decision IS NULL AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS wm_plans_project ON wm_plans(project_id,status,due_on);
CREATE INDEX IF NOT EXISTS wm_tasks_progress ON wm_tasks(work_id,status);
CREATE INDEX IF NOT EXISTS wm_task_edges_successor ON wm_task_edges(work_id,succ,pred);
CREATE INDEX IF NOT EXISTS wm_task_criteria_consumers ON wm_task_criteria(node_id,node_revision,criterion_id);
CREATE INDEX IF NOT EXISTS wm_spec_nodes_work ON wm_spec_nodes(work_id);
CREATE INDEX IF NOT EXISTS wm_spec_nodes_parent ON wm_spec_nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS wm_instructions_pending ON wm_instructions(target_session_id,status,received_seq)
 WHERE status IN ('accepted','waiting_for_turn','waiting_for_task','pending_safe_point');
CREATE UNIQUE INDEX IF NOT EXISTS wm_attempts_lease ON wm_attempts(task_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS wm_attempts_running ON wm_attempts(session_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS wm_outbox_unpublished ON wm_outbox(published,seq) WHERE published=0;
CREATE INDEX IF NOT EXISTS wm_cross_db_intents_pending ON wm_cross_db_intents(state,op_id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS wm_task_hold_decisions_resolved ON wm_task_hold_decisions(chain_id,decision) WHERE decision='run_anyway' AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS wm_attempts_interrupted ON wm_attempts(session_id) WHERE status='interrupted';
CREATE INDEX IF NOT EXISTS wm_task_chains_queue ON wm_task_chains(work_id,state,created_at);
CREATE INDEX IF NOT EXISTS wm_tasks_chain ON wm_tasks(chain_id,step_index,stack_position);
CREATE INDEX IF NOT EXISTS wm_task_edges_chain ON wm_task_edges(chain_id,pred,succ);
CREATE INDEX IF NOT EXISTS wm_task_parts_order ON wm_task_parts(task_id,part_rank);
CREATE INDEX IF NOT EXISTS wm_task_part_edges_successor ON wm_task_part_edges(task_id,succ);
