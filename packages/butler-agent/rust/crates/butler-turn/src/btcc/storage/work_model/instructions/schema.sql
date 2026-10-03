CREATE TABLE IF NOT EXISTS wm_inboxes (
 session_id TEXT PRIMARY KEY, control_epoch INTEGER NOT NULL DEFAULT 0,
 sealed_turn_id TEXT, boundary_kind TEXT, sealed_seq INTEGER NOT NULL DEFAULT 0,
 boundary_seq INTEGER NOT NULL DEFAULT 0, observed_epoch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wm_instructions (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 session_id TEXT NOT NULL, operation_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
 sender_json TEXT NOT NULL, input_json TEXT NOT NULL, anchor_json TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('queue','steer')), status TEXT NOT NULL,
 anchor_task_id TEXT, anchor_turn_id TEXT, delivered_turn_id TEXT,
 draft_task_id TEXT, receipt_json TEXT NOT NULL, received_at TEXT NOT NULL,
 UNIQUE(session_id,operation_key)
);
CREATE INDEX IF NOT EXISTS wm_instruction_pending ON wm_instructions(session_id,status,seq);
CREATE INDEX IF NOT EXISTS wm_instruction_dispatch ON wm_instructions(status,seq);
CREATE INDEX IF NOT EXISTS wm_instruction_task_boundary ON wm_instructions(anchor_task_id,status,seq);
CREATE INDEX IF NOT EXISTS wm_instruction_turn_boundary ON wm_instructions(anchor_turn_id,status,seq);
CREATE TABLE IF NOT EXISTS wm_parent_authority (
 child_session_id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL,
 relation_id TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS wm_instruction_targets (
 instruction_id TEXT NOT NULL, target TEXT NOT NULL,
 PRIMARY KEY(instruction_id,target)
);
CREATE INDEX IF NOT EXISTS wm_instruction_target_conflict ON wm_instruction_targets(target,instruction_id);
CREATE TABLE IF NOT EXISTS wm_interrupted_turns (
 turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wm_interrupted_sessions ON wm_interrupted_turns(session_id,turn_id);
CREATE TABLE IF NOT EXISTS wm_instruction_operations (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, instruction_id TEXT NOT NULL,
 operation_id TEXT NOT NULL, UNIQUE(instruction_id,operation_id)
);
CREATE INDEX IF NOT EXISTS wm_instruction_operation_order ON wm_instruction_operations(instruction_id,seq);
