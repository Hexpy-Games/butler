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
  run_generation INTEGER NOT NULL DEFAULT 0 CHECK (run_generation >= 0),
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
  coverage_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(coverage_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  decision TEXT CHECK (decision IN ('run_anyway','delete')),
  decided_at INTEGER,
  resolved_at INTEGER,
  CHECK ((decision IS NULL) = (decided_at IS NULL))
);

CREATE TABLE IF NOT EXISTS wm_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL REFERENCES wm_works(id),
  spec_ref TEXT NOT NULL CHECK (json_valid(spec_ref)),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('execute','integrate','review')),
  status TEXT NOT NULL CHECK (status IN ('draft','pending','running','awaiting_review','completed','blocked','paused','stopped','cancelled')),
  task_rank TEXT NOT NULL CHECK (length(task_rank)>0 AND task_rank NOT GLOB '*[^0-9A-Za-z]*' AND task_rank NOT GLOB '*0'),
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
CREATE INDEX IF NOT EXISTS wm_work_chains_queue ON wm_work_chains(session_id,state,created_at);
CREATE INDEX IF NOT EXISTS wm_works_chain ON wm_works(chain_id,step_index,stack_position);
CREATE INDEX IF NOT EXISTS wm_work_edges_successor ON wm_work_edges(succ_work_id);
CREATE INDEX IF NOT EXISTS wm_work_edges_chain ON wm_work_edges(chain_id,pred_work_id,succ_work_id);
CREATE UNIQUE INDEX IF NOT EXISTS wm_hold_decisions_pending ON wm_hold_decisions(chain_id,held_step_index) WHERE decision IS NULL AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS wm_plans_project ON wm_plans(project_id,status,due_on);
CREATE INDEX IF NOT EXISTS wm_tasks_order ON wm_tasks(work_id,task_rank);
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
CREATE INDEX IF NOT EXISTS wm_hold_decisions_resolved ON wm_hold_decisions(chain_id,decision) WHERE decision='run_anyway' AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS wm_attempts_interrupted ON wm_attempts(session_id) WHERE status='interrupted';

-- Public preview 14 topics. Static seed; compressed spec bodies are zstd.
BEGIN;
INSERT INTO wm_plans(id,project_id,title,description,status,visibility,revision,created_at,updated_at,created_by) VALUES('pl_p14','butler','프리뷰 14','','open','canon',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_works(id,scope_kind,scope_ref,plan_id,home_session_id,title,run_state,canon_status,canon_status_source,visibility,origin,plan_rank,failure_reason,result_reported_at,revision,created_at,updated_at,created_by) VALUES('wk_canon','project','butler','pl_p14','chat_canon','캐논','running','in_progress','runtime','canon','board','8',NULL,NULL,1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_bodies(hash,body,bytes) VALUES('71d5d31a9b39588ae94cedea89010f0fc5dddc20225d78532be9d9a73dfce715',X'28b52ffd208b590400eab384ed9a8dc2b7eab3bceca09cc2b7ebaa85ec84b8eba5bc20ec82acec9aa9ec9e90eab08020eca781eca09120ed8eb8eca791ed9598eab3a020ed9891ec9785ec9e90ec998020eab3b5ec9ca0ed959ceb8ba42e20ec9e91ec9785c2b7ec8b9ceb8f84c2b7eab280ed86a0eb8a9420ec8ba4ed968920ec9b90ec9ea5ec979020ec88a8eab8b4eb8ba42e',139);
INSERT INTO wm_spec_nodes(node_id,scope_kind,scope_ref,work_id,concern_id,visibility,lifecycle,source,revision,created_at,updated_at,created_by) VALUES('sp_canon','project','butler','wk_canon','canon','canon','active','repo',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_revisions(node_id,revision,body_hash,parser_version,state) VALUES('sp_canon',1,'71d5d31a9b39588ae94cedea89010f0fc5dddc20225d78532be9d9a73dfce715','1','active');
UPDATE wm_spec_nodes SET active_revision=1 WHERE node_id='sp_canon';
UPDATE wm_works SET spec_node_id='sp_canon' WHERE id='wk_canon';
INSERT INTO wm_works(id,scope_kind,scope_ref,plan_id,home_session_id,title,run_state,canon_status,canon_status_source,visibility,origin,plan_rank,failure_reason,result_reported_at,revision,created_at,updated_at,created_by) VALUES('wk_queue','project','butler','pl_p14','chat_queue','작업 큐','failed','blocked','runtime','canon','board','G','task_failed',NULL,1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_bodies(hash,body,bytes) VALUES('baea7d50946ee5c1453ebb52e1a4eccd19e0e9519a773d4a0324a87894de55a2',X'28b52ffd600000fd0500520c2928a027e989fec31149f8a2adbcefb7769676492ab62df9e4ec5ece166af7adfd1daaaa2ad8b450c53509981e68dee4dd612645c05b80e0e419068a1fa2bb1824d69c3d7f243caab711498ed9293812191eb88e37788708684d30ef30b7e74e7ebdc37421983be5a7705933b4e02610e9615e00c8c391f7f5de10ddd8708bdc453173ae5376ccb4285e4412946e02a697e62edea3f2a85e81e6ed79619ac0e1853125cb01080053082d9fe5c7304600bd5f87762e2a0e6fe5c8cdabf4',256);
INSERT INTO wm_spec_nodes(node_id,scope_kind,scope_ref,work_id,concern_id,visibility,lifecycle,source,revision,created_at,updated_at,created_by) VALUES('sp_queue','project','butler','wk_queue','queue','canon','active','repo',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_revisions(node_id,revision,body_hash,parser_version,state) VALUES('sp_queue',1,'baea7d50946ee5c1453ebb52e1a4eccd19e0e9519a773d4a0324a87894de55a2','1','active');
UPDATE wm_spec_nodes SET active_revision=1 WHERE node_id='sp_queue';
UPDATE wm_works SET spec_node_id='sp_queue' WHERE id='wk_queue';
INSERT INTO wm_works(id,scope_kind,scope_ref,plan_id,home_session_id,title,run_state,canon_status,canon_status_source,visibility,origin,plan_rank,failure_reason,result_reported_at,revision,created_at,updated_at,created_by) VALUES('wk_blocks','project','butler','pl_p14','chat_blocks','시각화 블록','idle','planned','person','canon','board','O',NULL,NULL,1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_bodies(hash,body,bytes) VALUES('5d616c39bbf9f6b504089ef27750a40770249cb90bc4312dbb82eabf34142342',X'28b52ffd2066310300eb8bb5ebb380ec9d8420eb9494ec9e90ec9db820ec8b9cec8aa4ed859c20ecbbb4ed8faceb848ced8ab8eba19c20eab7b8eba6b0eb8ba42e20eab084eab2b0ed959c204a534f4e20ebaa85ec84b820ebb894eba19dec9d8420ec82acec9aa9ed959ceb8ba42e',102);
INSERT INTO wm_spec_nodes(node_id,scope_kind,scope_ref,work_id,concern_id,visibility,lifecycle,source,revision,created_at,updated_at,created_by) VALUES('sp_blocks','project','butler','wk_blocks','blocks','canon','active','repo',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_revisions(node_id,revision,body_hash,parser_version,state) VALUES('sp_blocks',1,'5d616c39bbf9f6b504089ef27750a40770249cb90bc4312dbb82eabf34142342','1','active');
UPDATE wm_spec_nodes SET active_revision=1 WHERE node_id='sp_blocks';
UPDATE wm_works SET spec_node_id='sp_blocks' WHERE id='wk_blocks';
INSERT INTO wm_works(id,scope_kind,scope_ref,plan_id,home_session_id,title,run_state,canon_status,canon_status_source,visibility,origin,plan_rank,failure_reason,result_reported_at,revision,created_at,updated_at,created_by) VALUES('wk_docs','project','butler','pl_p14','chat_docs','문서','idle','planned','person','canon','board','W',NULL,NULL,1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_bodies(hash,body,bytes) VALUES('92ac019bab23c828ae4ccca51d612dca517d3e65b1a74cb676a477a73143815a',X'28b52ffd20575d02001404ebb284ed8b80eb9faceab08020eba78ceb93a020ebacb8ec849ceba5bc20ec849ceb9e8dec979020eca084eb8baced959ceb8ba42e97b4eb9e8ced959ceb8ba42e02004f7150b14d28',87);
INSERT INTO wm_spec_nodes(node_id,scope_kind,scope_ref,work_id,concern_id,visibility,lifecycle,source,revision,created_at,updated_at,created_by) VALUES('sp_docs','project','butler','wk_docs','docs','canon','active','repo',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_revisions(node_id,revision,body_hash,parser_version,state) VALUES('sp_docs',1,'92ac019bab23c828ae4ccca51d612dca517d3e65b1a74cb676a477a73143815a','1','active');
UPDATE wm_spec_nodes SET active_revision=1 WHERE node_id='sp_docs';
UPDATE wm_works SET spec_node_id='sp_docs' WHERE id='wk_docs';
INSERT INTO wm_works(id,scope_kind,scope_ref,plan_id,home_session_id,title,run_state,canon_status,canon_status_source,visibility,origin,plan_rank,failure_reason,result_reported_at,revision,created_at,updated_at,created_by) VALUES('wk_images','project','butler','pl_p14','chat_images','이미지 도구','done','done','runtime','canon','board','e',NULL,3,1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_bodies(hash,body,bytes) VALUES('cf67b224683f1bb831cbd3b4134b82fafe5c302428015b7246d1b4fb00ef3820',X'28b52ffd205ec50200e404ec9db4ebafb8eca780eba5bc20eba78ceb93a4eab3a020ed8eb8eca791ed9598eb8a9420eb8f84eab5aceca09ceab3b5ed959ceb8ba42e20ec9db4b184ed8c85ec9790ec849c20ec93b4eb8ba42e02007ff212b15419',94);
INSERT INTO wm_spec_nodes(node_id,scope_kind,scope_ref,work_id,concern_id,visibility,lifecycle,source,revision,created_at,updated_at,created_by) VALUES('sp_images','project','butler','wk_images','images','canon','active','repo',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_revisions(node_id,revision,body_hash,parser_version,state) VALUES('sp_images',1,'cf67b224683f1bb831cbd3b4134b82fafe5c302428015b7246d1b4fb00ef3820','1','active');
UPDATE wm_spec_nodes SET active_revision=1 WHERE node_id='sp_images';
UPDATE wm_works SET spec_node_id='sp_images' WHERE id='wk_images';
INSERT INTO wm_works(id,scope_kind,scope_ref,plan_id,home_session_id,title,run_state,canon_status,canon_status_source,visibility,origin,plan_rank,failure_reason,result_reported_at,revision,created_at,updated_at,created_by) VALUES('wk_login','project','butler','pl_p14','chat_login','ChatGPT 공식 로그인','idle','planned','person','canon','board','m',NULL,NULL,1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_bodies(hash,body,bytes) VALUES('a56d48fffabb68fa4f95d6486be116c8cfb5385bd1b1dc0382e601497c70799e',X'28b52ffd2059c90200ebb98ceba0a420ec93b0eb8d9820eba19ceab7b8ec9db8ec9d8420eab590ecb2b4ed959ceb8ba42e204f70656e414920eab3b5ec8b9d204368617447505420eba19ceab7b8ec9db8ec9cbceba19c20ebb094eabebceb8ba42e',89);
INSERT INTO wm_spec_nodes(node_id,scope_kind,scope_ref,work_id,concern_id,visibility,lifecycle,source,revision,created_at,updated_at,created_by) VALUES('sp_login','project','butler','wk_login','login','canon','active','repo',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_revisions(node_id,revision,body_hash,parser_version,state) VALUES('sp_login',1,'a56d48fffabb68fa4f95d6486be116c8cfb5385bd1b1dc0382e601497c70799e','1','active');
UPDATE wm_spec_nodes SET active_revision=1 WHERE node_id='sp_login';
UPDATE wm_works SET spec_node_id='sp_login' WHERE id='wk_login';
INSERT INTO wm_works(id,scope_kind,scope_ref,plan_id,home_session_id,title,run_state,canon_status,canon_status_source,visibility,origin,plan_rank,failure_reason,result_reported_at,revision,created_at,updated_at,created_by) VALUES('wk_crates','project','butler','pl_p14','chat_crates','크레이트 분리','idle','planned','person','canon','board','u',NULL,NULL,1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_bodies(hash,body,bytes) VALUES('791705aa8ed9ac58b9dbb1beebfdf83b586f05d3f3c259c4914a3d61217b12dd',X'28b52ffd204e710200ed81b020ed81aceba088ec9db4ed8ab8eba5bc20eb8298eb8888eb8ba42e20ebb98ceb939c20ec8b9ceab084ec9d8420eca484ec9db4eb8a9420eab283ec9db420ebaaa9eca081ec9db4eb8ba42e',78);
INSERT INTO wm_spec_nodes(node_id,scope_kind,scope_ref,work_id,concern_id,visibility,lifecycle,source,revision,created_at,updated_at,created_by) VALUES('sp_crates','project','butler','wk_crates','crates','canon','active','repo',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_spec_revisions(node_id,revision,body_hash,parser_version,state) VALUES('sp_crates',1,'791705aa8ed9ac58b9dbb1beebfdf83b586f05d3f3c259c4914a3d61217b12dd','1','active');
UPDATE wm_spec_nodes SET active_revision=1 WHERE node_id='sp_crates';
UPDATE wm_works SET spec_node_id='sp_crates' WHERE id='wk_crates';
INSERT INTO wm_work_chains(id,session_id,created_at,graph_revision,state) VALUES('ch_canon','chat_canon',1,1,'active');
UPDATE wm_works SET chain_id='ch_canon',step_index=0,stack_position=0,queue_origin='user_message',origin_message_id='msg_canon' WHERE id='wk_canon';
INSERT INTO wm_work_chains(id,session_id,created_at,graph_revision,state) VALUES('ch_queue','chat_queue',1,1,'held');
UPDATE wm_works SET chain_id='ch_queue',step_index=0,stack_position=0,queue_origin='user_message',origin_message_id='msg_queue' WHERE id='wk_queue';
INSERT INTO wm_work_chains(id,session_id,created_at,graph_revision,state) VALUES('ch_images','chat_images',1,1,'done');
UPDATE wm_works SET chain_id='ch_images',step_index=0,stack_position=0,queue_origin='user_message',origin_message_id='msg_images' WHERE id='wk_images';
INSERT INTO wm_works(id,scope_kind,scope_ref,home_session_id,title,run_state,visibility,origin,chain_id,step_index,stack_position,hold_reason,held_by_work_id,queue_origin,origin_message_id,revision,created_at,updated_at,created_by) VALUES('wk_schema','session','chat_canon',NULL,'스키마 크레이트','waiting','private','chat','ch_canon',1,0,NULL,NULL,'user_message','msg_schema',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_works(id,scope_kind,scope_ref,home_session_id,title,run_state,visibility,origin,chain_id,step_index,stack_position,hold_reason,held_by_work_id,queue_origin,origin_message_id,revision,created_at,updated_at,created_by) VALUES('wk_store','session','chat_canon',NULL,'저장소 연산','waiting','private','chat','ch_canon',1,1,NULL,NULL,'user_message','msg_store',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_works(id,scope_kind,scope_ref,home_session_id,title,run_state,visibility,origin,chain_id,step_index,stack_position,hold_reason,held_by_work_id,queue_origin,origin_message_id,revision,created_at,updated_at,created_by) VALUES('wk_api','session','chat_canon',NULL,'API 라우트','waiting','private','chat','ch_canon',2,0,NULL,NULL,'user_message','msg_api',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_works(id,scope_kind,scope_ref,home_session_id,title,run_state,visibility,origin,chain_id,step_index,stack_position,hold_reason,held_by_work_id,queue_origin,origin_message_id,revision,created_at,updated_at,created_by) VALUES('wk_queue_ui','session','chat_queue',NULL,'대기열 화면','held','private','chat','ch_queue',1,0,'predecessor_failed','wk_queue','user_message','msg_queue_ui',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_work_edges(pred_work_id,succ_work_id,chain_id) VALUES('wk_canon','wk_schema','ch_canon');
INSERT INTO wm_work_edges(pred_work_id,succ_work_id,chain_id) VALUES('wk_canon','wk_store','ch_canon');
INSERT INTO wm_work_edges(pred_work_id,succ_work_id,chain_id) VALUES('wk_schema','wk_api','ch_canon');
INSERT INTO wm_work_edges(pred_work_id,succ_work_id,chain_id) VALUES('wk_store','wk_api','ch_canon');
INSERT INTO wm_work_edges(pred_work_id,succ_work_id,chain_id) VALUES('wk_queue','wk_queue_ui','ch_queue');
INSERT INTO wm_hold_decisions(id,chain_id,failed_work_id,held_step_index,question_message_id,coverage_json) VALUES('hd_queue','ch_queue','wk_queue',1,'msg_hold','[{"id":"wk_queue","step":0,"state":"failed","generation":0}]');
INSERT INTO wm_works(id,scope_kind,scope_ref,title,run_state,canon_status,canon_status_source,visibility,origin,plan_rank,revision,created_at,updated_at,created_by) VALUES('wk_passkey','project','butler','패스키 로그인','idle','planned','person','canon','board','G',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_works(id,scope_kind,scope_ref,title,run_state,canon_status,canon_status_source,visibility,origin,plan_rank,revision,created_at,updated_at,created_by) VALUES('wk_bookmarks','project','butler','다른 브라우저에서 북마크 가져오기','idle','planned','person','canon','board','W',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_works(id,scope_kind,scope_ref,home_session_id,title,run_state,visibility,origin,revision,created_at,updated_at,created_by) VALUES('wk_minutes','session','chat_minutes',NULL,'회의록 정리','idle','private','chat',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_tasks(id,work_id,spec_ref,title,kind,status,task_rank,revision,created_at,updated_at,created_by) VALUES('tk_schema','wk_canon','{"node_id":"sp_canon","revision":1,"body_hash":"71d5d31a9b39588ae94cedea89010f0fc5dddc20225d78532be9d9a73dfce715"}','저장 형식 정의','execute','running','G',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_tasks(id,work_id,spec_ref,title,kind,status,task_rank,revision,created_at,updated_at,created_by) VALUES('tk_crud','wk_canon','{"node_id":"sp_canon","revision":1,"body_hash":"71d5d31a9b39588ae94cedea89010f0fc5dddc20225d78532be9d9a73dfce715"}','편집 연산 연결','execute','pending','W',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_tasks(id,work_id,spec_ref,title,kind,status,task_rank,revision,created_at,updated_at,created_by) VALUES('tk_board','wk_canon','{"node_id":"sp_canon","revision":1,"body_hash":"71d5d31a9b39588ae94cedea89010f0fc5dddc20225d78532be9d9a73dfce715"}','보드 순서 검토','execute','draft','m',1,1,1,'{"person":"fixture"}');
INSERT INTO wm_task_edges(work_id,pred,succ) VALUES('wk_canon','tk_schema','tk_crud');
INSERT INTO wm_spec_criteria(node_id,revision,criterion_id,part_id,text) VALUES('sp_canon',1,'edit','main','계획·과제·명세를 편집할 수 있다.');
INSERT INTO wm_task_criteria(task_id,node_id,node_revision,criterion_id) VALUES('tk_schema','sp_canon',1,'edit');
INSERT INTO wm_task_criteria(task_id,node_id,node_revision,criterion_id) VALUES('tk_crud','sp_canon',1,'edit');
INSERT INTO wm_attempts(id,task_id,task_revision,spec_ref,session_id,lease_epoch,status,started_at) VALUES('at_schema','tk_schema',1,'{"node_id":"sp_canon","revision":1,"body_hash":"71d5d31a9b39588ae94cedea89010f0fc5dddc20225d78532be9d9a73dfce715"}','chat_canon',1,'running',2);
COMMIT;
