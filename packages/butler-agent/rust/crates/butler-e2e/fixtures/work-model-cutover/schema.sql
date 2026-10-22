-- Static deployed legacy schema used by deterministic migration contracts.
CREATE TABLE btcc_turns(turn_id TEXT PRIMARY KEY,session_id TEXT);

CREATE TABLE IF NOT EXISTS btcc_guided_works (
  work_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'project')),
  scope_ref TEXT NOT NULL,
  ledger_project_id TEXT,
  canonical_head_sha256 TEXT,
  origin_turn_id TEXT NOT NULL,
  origin_message_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'blocked', 'completed', 'abandoned')),
  current_plan_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_btcc_guided_works_session
ON btcc_guided_works(session_id, status, updated_at);

CREATE TABLE IF NOT EXISTS btcc_guided_work_session_heads (
  session_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_guided_turn_work_bindings (
  binding_revision_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  bound_at TEXT NOT NULL,
  UNIQUE(turn_id, revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_btcc_guided_turn_current_work
ON btcc_guided_turn_work_bindings(turn_id) WHERE is_current = 1;

CREATE INDEX IF NOT EXISTS idx_btcc_guided_turn_work_history
ON btcc_guided_turn_work_bindings(work_id, turn_id, revision);

CREATE TABLE IF NOT EXISTS btcc_guided_work_relation_commands (
  mutation_call_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('start_work', 'continue_work')),
  request_sha256 TEXT NOT NULL,
  work_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS btcc_guided_work_plan_revisions (
  plan_revision_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  objective TEXT NOT NULL,
  governing_refs_json TEXT NOT NULL,
  execution_mode TEXT CHECK (execution_mode IN ('direct', 'steward', 'workers')),
  actions_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  origin_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(work_id, revision)
);


CREATE TABLE IF NOT EXISTS btcc_guided_work_results (
  result_ref TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  tool_call_id TEXT NOT NULL UNIQUE,
  origin_turn_id TEXT NOT NULL,
  source_turn_rowid INTEGER,
  source_turn_sequence INTEGER,
  attached_at TEXT NOT NULL,
  UNIQUE(work_id, sequence)
);


CREATE TABLE IF NOT EXISTS btcc_guided_work_checkpoint_revisions (
  checkpoint_revision_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  plan_revision_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (
    stage IN ('conception', 'planning', 'execution', 'review', 'validation', 'reporting')
  ),
  public_summary TEXT NOT NULL,
  next_step TEXT NOT NULL,
  action_states_json TEXT NOT NULL,
  result_sequence INTEGER NOT NULL,
  origin_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(work_id, revision)
);


CREATE TABLE IF NOT EXISTS btcc_guided_work_review_revisions (
  review_revision_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  subject TEXT NOT NULL CHECK (subject IN ('plan', 'result', 'completion')),
  verdict TEXT NOT NULL CHECK (verdict IN ('accept', 'revise', 'partial')),
  summary TEXT NOT NULL,
  corrections_json TEXT NOT NULL,
  bound_plan_revision_id TEXT,
  bound_result_sequence INTEGER,
  bound_result_review_revision_id TEXT,
  bound_action_states_json TEXT,
  origin_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(work_id, revision),
  CHECK (
    (subject = 'plan' AND bound_plan_revision_id IS NOT NULL
      AND bound_result_sequence IS NULL
      AND bound_result_review_revision_id IS NULL
      AND bound_action_states_json IS NULL)
    OR
    (subject = 'result' AND bound_plan_revision_id IS NULL
      AND bound_result_sequence IS NOT NULL
      AND bound_result_review_revision_id IS NULL
      AND bound_action_states_json IS NULL)
    OR
    (subject = 'completion' AND bound_plan_revision_id IS NOT NULL
      AND bound_result_sequence IS NOT NULL
      AND bound_result_review_revision_id IS NOT NULL
      AND bound_action_states_json IS NOT NULL)
  )
);


CREATE TABLE IF NOT EXISTS btcc_guided_work_disposition_revisions (
  disposition_revision_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  result_sequence INTEGER NOT NULL DEFAULT 0,
  material_fingerprint TEXT NOT NULL DEFAULT '',
  runtime_owned_open INTEGER NOT NULL DEFAULT 0 CHECK (runtime_owned_open IN (0, 1)),
  disposition TEXT NOT NULL CHECK (disposition IN ('completed', 'open', 'blocked')),
  summary TEXT NOT NULL,
  action_updates_json TEXT NOT NULL,
  remaining_actions_json TEXT NOT NULL,
  next_condition TEXT,
  evidence_refs_json TEXT NOT NULL,
  evidence_snapshot_json TEXT NOT NULL,
  followups_json TEXT NOT NULL,
  origin_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(work_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_btcc_guided_work_dispositions_work
ON btcc_guided_work_disposition_revisions(work_id, revision);

CREATE TABLE IF NOT EXISTS btcc_guided_work_disposition_commands (
  mutation_call_id TEXT PRIMARY KEY,
  request_sha256 TEXT NOT NULL,
  work_id TEXT NOT NULL,
  disposition_revision_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_guided_work_closeout_diagnostics (
  diagnostic_id TEXT PRIMARY KEY,
  diagnostic_key TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL CHECK (code = 'closeout_missing'),
  turn_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_btcc_guided_work_closeout_diagnostics_turn
ON btcc_guided_work_closeout_diagnostics(turn_id, work_id);


CREATE TABLE IF NOT EXISTS btcc_guided_work_mutations (
  mutation_call_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (
    operation IN ('replace_plan', 'record_checkpoint', 'record_review', 'attach_tool_result')
  ),
  request_sha256 TEXT NOT NULL,
  work_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_guided_work_legacy_imports (
  import_id TEXT PRIMARY KEY,
  legacy_program_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'project')),
  scope_ref TEXT NOT NULL,
  source_authority TEXT NOT NULL CHECK (
    source_authority IN ('session_sqlite', 'project_ledger')
  ),
  source_revision TEXT NOT NULL,
  work_id TEXT NOT NULL UNIQUE,
  imported_at TEXT NOT NULL,
  UNIQUE(legacy_program_id, session_id, scope_kind, scope_ref)
);


CREATE TABLE IF NOT EXISTS btcc_session_relations (
  relation_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  parent_turn_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL UNIQUE,
  anchor_message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  safe_title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(parent_session_id, ordinal)
);

CREATE TABLE IF NOT EXISTS btcc_subsession_delegations (
  delegation_id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL UNIQUE,
  child_turn_id TEXT NOT NULL UNIQUE,
  root_work_id TEXT NOT NULL UNIQUE,
  packet_json TEXT NOT NULL,
  dispatch_intent_json TEXT,
  dispatch_state TEXT CHECK (dispatch_state IS NULL OR dispatch_state IN ('pending', 'enqueued')),
  created_at TEXT NOT NULL,
  FOREIGN KEY(relation_id) REFERENCES btcc_session_relations(relation_id)
);

CREATE INDEX IF NOT EXISTS idx_btcc_graph_parent_turn
ON btcc_session_relations(parent_session_id,parent_turn_id,ordinal);

CREATE TABLE IF NOT EXISTS btcc_subsession_directions (
  instruction_id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_parent_turn_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  applied_child_turn_id TEXT,
  UNIQUE(relation_id, revision),
  UNIQUE(relation_id, source_message_id),
  FOREIGN KEY(relation_id) REFERENCES btcc_session_relations(relation_id)
);

CREATE INDEX IF NOT EXISTS idx_btcc_subsession_directions_pending
ON btcc_subsession_directions(relation_id, status, revision);

CREATE TABLE IF NOT EXISTS btcc_steward_results (
  result_id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL,
  direction_revision INTEGER NOT NULL DEFAULT 0,
  task_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  child_turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'blocked', 'failed', 'cancelled')),
  code TEXT CHECK (code IS NULL OR code IN (
    'delegation_context_incomplete',
    'capability_unavailable_in_child',
    'steward_execution_failed', 'steward_cancelled',
    'worker_work_incomplete', 'worker_no_progress'
  )),
  summary TEXT NOT NULL,
  failure_key TEXT,
  acceptance_evidence_json TEXT NOT NULL,
  changed_artifacts_json TEXT NOT NULL,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  commits_json TEXT NOT NULL DEFAULT '[]',
  tests_json TEXT NOT NULL DEFAULT '[]',
  remaining_risks_json TEXT NOT NULL DEFAULT '[]',
  follow_up_recommendations_json TEXT NOT NULL DEFAULT '[]',
  detail_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY(relation_id) REFERENCES btcc_session_relations(relation_id)
);

CREATE INDEX IF NOT EXISTS idx_btcc_graph_result
ON btcc_steward_results(relation_id,created_at DESC,result_id DESC);

CREATE TABLE IF NOT EXISTS btcc_subsession_outbox (
  outbox_id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL,
  result_id TEXT NOT NULL UNIQUE,
  parent_session_id TEXT NOT NULL,
  parent_turn_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY(relation_id) REFERENCES btcc_session_relations(relation_id)
);


CREATE INDEX IF NOT EXISTS idx_btcc_graph_checkpoint_plan
ON btcc_guided_work_checkpoint_revisions(work_id,plan_revision_id,revision DESC);
CREATE INDEX IF NOT EXISTS idx_btcc_graph_bindings_session
ON btcc_guided_turn_work_bindings(session_id,work_id) WHERE is_current=1;
CREATE INDEX IF NOT EXISTS idx_btcc_graph_bindings_work
ON btcc_guided_turn_work_bindings(work_id,session_id) WHERE is_current=1;
CREATE INDEX IF NOT EXISTS idx_btcc_graph_work
ON btcc_subsession_delegations(json_extract(packet_json,'$.parent_work_ref.work_id'));
CREATE TABLE IF NOT EXISTS agent_task_graph_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS task_graph_binding_insert AFTER INSERT ON btcc_guided_turn_work_bindings WHEN NEW.is_current=1 BEGIN
    INSERT INTO agent_task_graph_changes(session_id) VALUES(NEW.session_id)
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_work_insert AFTER INSERT ON btcc_guided_works BEGIN
    INSERT INTO agent_task_graph_changes(session_id) VALUES(NEW.session_id)
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_work_update AFTER UPDATE ON btcc_guided_works BEGIN
    INSERT INTO agent_task_graph_changes(session_id) VALUES(NEW.session_id)
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
    INSERT INTO agent_task_graph_changes(session_id) SELECT session_id FROM btcc_guided_turn_work_bindings WHERE work_id=NEW.work_id AND is_current=1
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_plan_insert AFTER INSERT ON btcc_guided_work_plan_revisions BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT session_id FROM btcc_guided_works WHERE work_id=NEW.work_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_checkpoint_insert AFTER INSERT ON btcc_guided_work_checkpoint_revisions BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT session_id FROM btcc_guided_works WHERE work_id=NEW.work_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
    INSERT INTO agent_task_graph_changes(session_id) SELECT r.parent_session_id FROM btcc_subsession_delegations d JOIN btcc_session_relations r ON r.relation_id=d.relation_id WHERE d.root_work_id=NEW.work_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_delegation_insert AFTER INSERT ON btcc_subsession_delegations BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT parent_session_id FROM btcc_session_relations WHERE relation_id=NEW.relation_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_result_insert AFTER INSERT ON btcc_steward_results BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT parent_session_id FROM btcc_session_relations WHERE relation_id=NEW.relation_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_turn_insert AFTER INSERT ON btcc_turns BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT parent_session_id FROM btcc_session_relations WHERE child_session_id=NEW.session_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_turn_update AFTER UPDATE ON btcc_turns BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT parent_session_id FROM btcc_session_relations WHERE child_session_id=NEW.session_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;

CREATE INDEX wm_legacy_session_work ON btcc_guided_works(session_id,work_id);
CREATE INDEX wm_pending_directions ON btcc_subsession_directions(instruction_id) WHERE status='pending';
