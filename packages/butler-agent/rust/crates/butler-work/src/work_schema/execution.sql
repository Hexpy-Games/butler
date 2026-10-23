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
