CREATE TABLE IF NOT EXISTS wm_mode (singleton INTEGER PRIMARY KEY CHECK(singleton=1), writer_epoch INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wm_intents (
  session_id TEXT NOT NULL, operation_key TEXT NOT NULL, instruction_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL, request_json TEXT NOT NULL, receipt_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(session_id, operation_key)
);
CREATE INDEX IF NOT EXISTS wm_pending_intents ON wm_intents(session_id,operation_key) WHERE receipt_json IS NULL;
CREATE TABLE IF NOT EXISTS wm_specs (
  scope_id TEXT NOT NULL, node_id TEXT NOT NULL, node_revision INTEGER NOT NULL,
  ledger_revision_id TEXT NOT NULL, content_hash TEXT NOT NULL, reference_json TEXT NOT NULL,
  parent_id TEXT, concern_id TEXT NOT NULL, independent_review INTEGER NOT NULL,
  PRIMARY KEY(scope_id,node_id,node_revision), UNIQUE(scope_id,ledger_revision_id)
);
CREATE TABLE IF NOT EXISTS wm_parts (
  scope_id TEXT NOT NULL, node_id TEXT NOT NULL, node_revision INTEGER NOT NULL, part_id TEXT NOT NULL,
  PRIMARY KEY(scope_id,node_id,node_revision,part_id),
  FOREIGN KEY(scope_id,node_id,node_revision) REFERENCES wm_specs(scope_id,node_id,node_revision)
);
CREATE TABLE IF NOT EXISTS wm_criteria (
  scope_id TEXT NOT NULL, node_id TEXT NOT NULL, node_revision INTEGER NOT NULL, criterion_id TEXT NOT NULL, part_id TEXT NOT NULL,
  PRIMARY KEY(scope_id,node_id,node_revision,criterion_id),
  FOREIGN KEY(scope_id,node_id,node_revision,part_id) REFERENCES wm_parts(scope_id,node_id,node_revision,part_id)
);
CREATE TABLE IF NOT EXISTS wm_plans (
  scope_id TEXT NOT NULL, id TEXT NOT NULL, owner_session_id TEXT NOT NULL, instruction_id TEXT NOT NULL,
  root_node_id TEXT NOT NULL, root_revision INTEGER NOT NULL, tier INTEGER NOT NULL CHECK(tier IN(1,2)),
  objective TEXT NOT NULL, graph_revision INTEGER NOT NULL, tree_version INTEGER NOT NULL,
  status TEXT NOT NULL, spec_count INTEGER NOT NULL, task_count INTEGER NOT NULL, edge_count INTEGER NOT NULL,
  event_seq INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'execution',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(scope_id,id), FOREIGN KEY(scope_id,root_node_id,root_revision) REFERENCES wm_specs(scope_id,node_id,node_revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS wm_plan_identity ON wm_plans(id);
CREATE INDEX IF NOT EXISTS wm_plan_session ON wm_plans(owner_session_id,status);
CREATE TABLE IF NOT EXISTS wm_tree (
  scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, node_id TEXT NOT NULL, node_revision INTEGER NOT NULL,
  parent_id TEXT, concern_id TEXT NOT NULL, lifecycle TEXT NOT NULL DEFAULT 'approved',
  PRIMARY KEY(scope_id,plan_id,node_id), UNIQUE(scope_id,plan_id,concern_id),
  FOREIGN KEY(scope_id,plan_id) REFERENCES wm_plans(scope_id,id),
  FOREIGN KEY(scope_id,node_id,node_revision) REFERENCES wm_specs(scope_id,node_id,node_revision)
);
CREATE INDEX IF NOT EXISTS wm_tree_parent ON wm_tree(scope_id,plan_id,parent_id);
CREATE TABLE IF NOT EXISTS wm_sessions (
  session_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, current_task_id TEXT,
  routing_reason TEXT NOT NULL, policy_revision INTEGER NOT NULL DEFAULT 1, selected_task_id TEXT,
  FOREIGN KEY(scope_id,plan_id) REFERENCES wm_plans(scope_id,id)
);
CREATE TABLE IF NOT EXISTS wm_works (
  scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, id TEXT NOT NULL, node_id TEXT NOT NULL, node_revision INTEGER NOT NULL,
  rank INTEGER NOT NULL, outcome TEXT NOT NULL, status TEXT NOT NULL, binding_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(scope_id,plan_id,id), FOREIGN KEY(scope_id,plan_id) REFERENCES wm_plans(scope_id,id),
  FOREIGN KEY(scope_id,node_id,node_revision) REFERENCES wm_specs(scope_id,node_id,node_revision)
);
CREATE TABLE IF NOT EXISTS wm_tasks (
  scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, work_id TEXT NOT NULL, id TEXT NOT NULL,
  node_id TEXT NOT NULL, node_revision INTEGER NOT NULL, rank INTEGER NOT NULL,
  status TEXT NOT NULL, revision INTEGER NOT NULL, card_json TEXT NOT NULL,
  PRIMARY KEY(scope_id,plan_id,id),
  FOREIGN KEY(scope_id,plan_id,work_id) REFERENCES wm_works(scope_id,plan_id,id),
  FOREIGN KEY(scope_id,node_id,node_revision) REFERENCES wm_specs(scope_id,node_id,node_revision)
);
CREATE INDEX IF NOT EXISTS wm_tasks_page ON wm_tasks(scope_id,plan_id,rank,id);
CREATE INDEX IF NOT EXISTS wm_tasks_work ON wm_tasks(scope_id,plan_id,work_id,status);
CREATE INDEX IF NOT EXISTS wm_tasks_node ON wm_tasks(scope_id,node_id,node_revision,plan_id);
CREATE TABLE IF NOT EXISTS wm_task_criteria (
  scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, task_id TEXT NOT NULL, node_id TEXT NOT NULL,
  node_revision INTEGER NOT NULL, criterion_id TEXT NOT NULL,
  PRIMARY KEY(scope_id,plan_id,task_id,criterion_id),
  FOREIGN KEY(scope_id,plan_id,task_id) REFERENCES wm_tasks(scope_id,plan_id,id),
  FOREIGN KEY(scope_id,node_id,node_revision,criterion_id) REFERENCES wm_criteria(scope_id,node_id,node_revision,criterion_id)
);
CREATE INDEX IF NOT EXISTS wm_criterion_consumers ON wm_task_criteria(scope_id,node_id,node_revision,criterion_id,plan_id);
CREATE TABLE IF NOT EXISTS wm_edges (
  scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, predecessor TEXT NOT NULL, successor TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  PRIMARY KEY(scope_id,plan_id,predecessor,successor),
  FOREIGN KEY(scope_id,plan_id,predecessor) REFERENCES wm_tasks(scope_id,plan_id,id),
  FOREIGN KEY(scope_id,plan_id,successor) REFERENCES wm_tasks(scope_id,plan_id,id)
);
CREATE INDEX IF NOT EXISTS wm_edges_reverse ON wm_edges(scope_id,plan_id,successor,predecessor);
CREATE TABLE IF NOT EXISTS wm_counts (
  scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL CHECK(total>=0),
  PRIMARY KEY(scope_id,plan_id,status), FOREIGN KEY(scope_id,plan_id) REFERENCES wm_plans(scope_id,id)
);
CREATE TABLE IF NOT EXISTS wm_attempts (
  scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL, session_id TEXT NOT NULL, instruction_id TEXT NOT NULL,
  spec_ref_json TEXT NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY(scope_id,plan_id,id), FOREIGN KEY(scope_id,plan_id,task_id) REFERENCES wm_tasks(scope_id,plan_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS wm_exclusive_lease ON wm_attempts(scope_id,plan_id,task_id) WHERE status='running';
CREATE TABLE IF NOT EXISTS wm_results (
  scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
  result_json TEXT NOT NULL, PRIMARY KEY(scope_id,plan_id,task_id,revision),
  FOREIGN KEY(scope_id,plan_id,task_id) REFERENCES wm_tasks(scope_id,plan_id,id)
);
CREATE TABLE IF NOT EXISTS wm_reviews (
  scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL, result_revision INTEGER NOT NULL, reviewer TEXT NOT NULL,
  accepted INTEGER NOT NULL, review_json TEXT NOT NULL,
  PRIMARY KEY(scope_id,plan_id,id), FOREIGN KEY(scope_id,plan_id,task_id) REFERENCES wm_tasks(scope_id,plan_id,id)
);
CREATE TABLE IF NOT EXISTS wm_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, scope_id TEXT NOT NULL, plan_id TEXT,
  session_id TEXT NOT NULL, instruction_id TEXT NOT NULL, operation_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wm_outbox (
  seq INTEGER PRIMARY KEY, event_json TEXT NOT NULL,
  FOREIGN KEY(seq) REFERENCES wm_audit(seq)
);

CREATE TABLE IF NOT EXISTS wm_coverage (
  scope_id TEXT NOT NULL, plan_id TEXT NOT NULL, node_id TEXT NOT NULL, node_revision INTEGER NOT NULL,
  criterion_id TEXT NOT NULL, child_node_id TEXT NOT NULL, child_revision INTEGER NOT NULL,
  child_criterion_id TEXT NOT NULL, semantics TEXT NOT NULL CHECK(semantics IN ('all','any')),
  PRIMARY KEY(scope_id,plan_id,node_id,criterion_id,child_node_id,child_criterion_id),
  FOREIGN KEY(scope_id,node_id,node_revision,criterion_id) REFERENCES wm_criteria(scope_id,node_id,node_revision,criterion_id),
  FOREIGN KEY(scope_id,child_node_id,child_revision,child_criterion_id) REFERENCES wm_criteria(scope_id,node_id,node_revision,criterion_id)
);
