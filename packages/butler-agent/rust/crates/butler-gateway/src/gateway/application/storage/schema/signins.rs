//! Sign-in module tables (no secrets), conversation site grants, schedule
//! grant sources and import summaries. Additive `IF NOT EXISTS`, plus the
//! idempotent removal of retired frame grants.
use rusqlite::Connection;

use super::super::AppStorageError;

pub(super) fn create(connection: &Connection) -> Result<(), AppStorageError> {
    connection
        .execute_batch(SIGNIN_SCHEMA)
        .map_err(AppStorageError::sqlite)
}

const SIGNIN_SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS browser_signin_entries (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL UNIQUE,
  origins_json TEXT NOT NULL,
  username TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('always', 'ask', 'never')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS browser_signin_audit (
  id INTEGER PRIMARY KEY,
  entry_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_signin_audit_entry_idx ON browser_signin_audit(entry_id, id DESC);
CREATE TABLE IF NOT EXISTS browser_site_grants (
  session_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  site TEXT NOT NULL,
  frame_site TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, site, frame_site)
);
CREATE INDEX IF NOT EXISTS browser_site_grants_site_idx ON browser_site_grants(site);
-- Embedded frames need no grant since decision 37; drop retired frame grants.
DELETE FROM browser_site_grants WHERE frame_site<>'';
CREATE TABLE IF NOT EXISTS browser_site_access (
  site TEXT PRIMARY KEY,
  all_conversations INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_automation_grant_sources (
  automation_id TEXT NOT NULL REFERENCES app_automations(id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL,
  PRIMARY KEY (automation_id, source_session_id)
);
CREATE TABLE IF NOT EXISTS app_automation_run_inputs (
  message_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES app_automation_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS automation_runs_turn_idx ON app_automation_runs(turn_id);
CREATE TABLE IF NOT EXISTS browser_import_audit (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
";
