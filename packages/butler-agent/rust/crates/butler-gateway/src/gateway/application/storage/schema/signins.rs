//! Sign-in module tables (no secrets), conversation site grants, schedule
//! grant sources and import summaries. Additive `IF NOT EXISTS`, plus the
//! idempotent removal of retired frame grants.
use rusqlite::Connection;

use super::super::AppStorageError;

pub(super) fn create(connection: &Connection) -> Result<(), AppStorageError> {
    connection
        .execute_batch(SIGNIN_SCHEMA)
        .map_err(AppStorageError::sqlite)?;
    migrate_accounts(connection)
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
CREATE INDEX IF NOT EXISTS session_queued_messages_turn_idx ON session_queued_messages(turn_id);
CREATE INDEX IF NOT EXISTS automation_runs_message_idx ON app_automation_runs(queued_message_id);
CREATE INDEX IF NOT EXISTS automation_runs_turn_idx ON app_automation_runs(turn_id);
DROP INDEX IF EXISTS automation_runs_started_idx;
CREATE INDEX IF NOT EXISTS browser_library_import_url ON browser_library(kind,url,group_id);
CREATE TABLE IF NOT EXISTS browser_import_schema(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS browser_signin_identity(
  origin TEXT NOT NULL, username TEXT NOT NULL, entry_id TEXT NOT NULL,
  PRIMARY KEY(origin,username)
);
CREATE INDEX IF NOT EXISTS browser_signin_identity_entry ON browser_signin_identity(entry_id);
CREATE TABLE IF NOT EXISTS browser_import_additions(
  run_id TEXT NOT NULL, kind TEXT NOT NULL, entry_id TEXT NOT NULL,
  PRIMARY KEY(run_id,kind,entry_id)
);
CREATE TABLE IF NOT EXISTS browser_signin_versions (
  entry_id TEXT PRIMARY KEY, modified_ms INTEGER NOT NULL, revision TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_import_updates (
  run_id TEXT NOT NULL, entry_id TEXT NOT NULL, previous_ms INTEGER NOT NULL,
  previous_revision TEXT NOT NULL, revision TEXT NOT NULL,
  PRIMARY KEY(run_id,entry_id)
);
CREATE TABLE IF NOT EXISTS browser_import_audit (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
";

/// Runs once, preserving existing IDs, policies, secrets and every origin.
fn migrate_accounts(db: &Connection) -> Result<(), AppStorageError> {
    use rusqlite::OptionalExtension;
    let migrated = db
        .query_row(
            "SELECT 1 FROM browser_import_schema WHERE version=2",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if migrated.is_some() {
        return Ok(());
    }
    db.execute_batch("SAVEPOINT browser_accounts;")
        .map_err(AppStorageError::sqlite)?;
    let result =
        super::migration::without_schema_revalidation(db, || db.execute_batch(ACCOUNTS_V2));
    let closed = db.execute_batch(if result.is_ok() {
        "RELEASE browser_accounts;"
    } else {
        "ROLLBACK TO browser_accounts; RELEASE browser_accounts;"
    });
    result.and(closed).map_err(AppStorageError::sqlite)
}

/// The generalized ALTER TABLE procedure: the rebuilt table takes the
/// original name, so the rename must not re-validate unrelated objects.
const ACCOUNTS_V2: &str = "
  CREATE TABLE browser_signin_entries_v2 (
    id TEXT PRIMARY KEY, site TEXT NOT NULL, origins_json TEXT NOT NULL, username TEXT NOT NULL,
    policy TEXT NOT NULL CHECK(policy IN ('always','ask','never')), source TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
  INSERT INTO browser_signin_entries_v2 SELECT * FROM browser_signin_entries;
  DROP TABLE browser_signin_entries;
  ALTER TABLE browser_signin_entries_v2 RENAME TO browser_signin_entries;
  CREATE INDEX browser_signin_entries_site ON browser_signin_entries(site,created_at,id);
  INSERT INTO browser_signin_identity(origin,username,entry_id)
    SELECT j.value,e.username,e.id FROM browser_signin_entries e,json_each(e.origins_json) j;
  INSERT INTO browser_import_schema VALUES(2);";
