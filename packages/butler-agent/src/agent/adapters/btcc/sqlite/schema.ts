import { BTCC_GUIDED_EFFECT_SCHEMA } from "./schema/guided-effect-schema.ts";
import { BTCC_GUIDED_WORK_SCHEMA } from "./schema/guided-work-schema.ts";
import { BTCC_TERMINAL_SETTLEMENT_WAKE_SCHEMA } from
  "./schema/terminal-settlement-wake-schema.ts";
import { BTCC_R3_LEGACY_TURN_CUTOVER_SCHEMA } from
  "./legacy-turn-cutover/index.ts";

export const BTCC_SUCCESSOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS btcc_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_inbound_inbox (
  inbox_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  admission_input_hash TEXT NOT NULL,
  command_json TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(session_id, trigger_key)
);

CREATE TABLE IF NOT EXISTS btcc_continuation_triggers (
  trigger_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  authorization_ref TEXT NOT NULL,
  content TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_admission_claims (
  claim_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_runtime_owners (
  owner_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  process_id INTEGER NOT NULL,
  process_started_at_ms INTEGER NOT NULL,
  owner_generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS btcc_records (
  record_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL UNIQUE,
  trigger_key TEXT NOT NULL,
  original_message_id TEXT NOT NULL,
  original_message TEXT NOT NULL,
  admission_snapshot_ref TEXT NOT NULL,
  model_selection_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  semantic_state TEXT NOT NULL CHECK (
    semantic_state IN ('admitted', 'delivery_committed', 'delivered', 'cancelled')
  ),
  active_checkpoint_id TEXT,
  route TEXT CHECK (route IS NULL OR route IN ('direct', 'assisted', 'managed')),
  final_payload_json TEXT,
  delivery_outbox_id TEXT,
  canonical_assistant_message_id TEXT,
  revision INTEGER NOT NULL,
  execution_fence INTEGER NOT NULL,
  final_disposition TEXT CHECK (
    final_disposition IS NULL OR final_disposition IN ('completed', 'cancelled')
  )
);

${BTCC_TERMINAL_SETTLEMENT_WAKE_SCHEMA}

CREATE TABLE IF NOT EXISTS btcc_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  turn_revision INTEGER NOT NULL,
  semantic_state TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'runtime'),
  checkpoint_revision INTEGER NOT NULL,
  active_claim_id TEXT,
  is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  UNIQUE(turn_id, turn_revision, semantic_state)
);

CREATE TABLE IF NOT EXISTS btcc_state_claims (
  claim_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  turn_revision INTEGER NOT NULL,
  semantic_state TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  checkpoint_revision INTEGER NOT NULL,
  execution_fence INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(turn_id, turn_revision, semantic_state)
);

CREATE TABLE IF NOT EXISTS btcc_stop_requests (
  stop_request_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  observed_turn_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_delivery_outbox (
  outbox_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL UNIQUE,
  committed_turn_revision INTEGER NOT NULL,
  payload_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  expected_message_id TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_guided_tool_calls (
  call_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  raw_arguments TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  result_sha256 TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(turn_id, call_id)
);

CREATE INDEX IF NOT EXISTS idx_btcc_guided_tool_calls_turn
ON btcc_guided_tool_calls(turn_id, started_at);

${BTCC_GUIDED_WORK_SCHEMA}
${BTCC_GUIDED_EFFECT_SCHEMA}
${BTCC_R3_LEGACY_TURN_CUTOVER_SCHEMA}

CREATE TABLE IF NOT EXISTS btcc_canonical_deliveries (
  turn_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL UNIQUE,
  assistant_message_id TEXT NOT NULL UNIQUE,
  inserted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_context_documents (
  context_ref TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  projection_class TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(scope_kind, scope_id, projection_class, source_id, source_revision)
);
`;
