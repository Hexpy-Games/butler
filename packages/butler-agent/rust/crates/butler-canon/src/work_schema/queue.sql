CREATE TABLE IF NOT EXISTS canon_session_queue_heads (
  session_id TEXT PRIMARY KEY NOT NULL,
  graph_revision INTEGER NOT NULL DEFAULT 0 CHECK(graph_revision >= 0)
);
CREATE TABLE IF NOT EXISTS canon_session_queue (
  session_id TEXT NOT NULL,
  epic_id TEXT NOT NULL REFERENCES canon_epics(id),
  chain_id TEXT NOT NULL,
  step_index INTEGER NOT NULL CHECK(step_index >= 0),
  stack_position INTEGER NOT NULL CHECK(stack_position >= 0),
  state TEXT NOT NULL CHECK(state IN ('waiting','running','held','done','removed')),
  hold_reason TEXT,
  held_by_epic_id TEXT,
  decision TEXT CHECK(decision IN ('delete','continue')),
  decided_at INTEGER,
  question_message_id TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('user_message','schedule','detach')),
  origin_message_id TEXT,
  step_op_id TEXT,
  started_at INTEGER,
  btcc_work_id TEXT,
  result_reported_at INTEGER,
  PRIMARY KEY(session_id,epic_id)
);
CREATE TABLE IF NOT EXISTS canon_session_queue_chains (
  session_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  plan_id TEXT REFERENCES canon_plans(id) ON DELETE SET NULL,
  PRIMARY KEY(session_id,chain_id)
);
CREATE INDEX IF NOT EXISTS canon_queue_running ON canon_session_queue(state,step_op_id) WHERE state='running' AND hold_reason IS NULL AND step_op_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS canon_queue_chain ON canon_session_queue(session_id,chain_id,step_index,stack_position);
CREATE INDEX IF NOT EXISTS canon_queue_active_session_chain ON canon_session_queue(session_id,chain_id) WHERE state IN ('waiting','running','held');
CREATE UNIQUE INDEX IF NOT EXISTS canon_queue_active_epic ON canon_session_queue(epic_id) WHERE state IN ('waiting','running','held');
CREATE INDEX IF NOT EXISTS canon_queue_op ON canon_session_queue(step_op_id) WHERE step_op_id IS NOT NULL;
-- Include state in the key so SQLite prefers the session seek over the replay state index.
CREATE INDEX IF NOT EXISTS canon_intents_pending_session ON canon_intents(state,json_extract(payload_json,'$.session_id'),kind) WHERE state='pending';
CREATE INDEX IF NOT EXISTS canon_intents_pending_other_session ON canon_intents(state,json_extract(payload_json,'$.other_session_id'),kind) WHERE state='pending';
CREATE INDEX IF NOT EXISTS canon_intents_take ON canon_intents(json_extract(payload_json,'$.session_id'),json_extract(payload_json,'$.epic_id')) WHERE kind='canon_take_here';
CREATE INDEX IF NOT EXISTS canon_queue_intents_pending ON canon_intents(state) WHERE state='pending' AND kind IN ('canon_step','canon_hold','canon_take_here');

-- A moved step keeps its cancellation identity after its queue row is removed.
CREATE TABLE IF NOT EXISTS canon_step_cancellations (
  op_id TEXT PRIMARY KEY NOT NULL,
  epic_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS canon_cancellations_epic ON canon_step_cancellations(epic_id);
CREATE INDEX IF NOT EXISTS canon_cancellations_source ON canon_step_cancellations(source_session_id);
