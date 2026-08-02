export const BTCC_GUIDED_WORK_CHECKPOINT_TABLE_SCHEMA = `
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
`;

export const BTCC_GUIDED_WORK_REVIEW_TABLE_SCHEMA = `
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
`;

export const BTCC_GUIDED_WORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS btcc_guided_works (
  work_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'project')),
  scope_ref TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS btcc_guided_work_plan_revisions (
  plan_revision_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  objective TEXT NOT NULL,
  governing_refs_json TEXT NOT NULL,
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
  attached_at TEXT NOT NULL,
  UNIQUE(work_id, sequence)
);

${BTCC_GUIDED_WORK_CHECKPOINT_TABLE_SCHEMA}
${BTCC_GUIDED_WORK_REVIEW_TABLE_SCHEMA}

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
`;
