//! Payment vault and autofill profiles (no secrets: card numbers, CVCs and
//! identity numbers live only in the OS credential store), their per-site
//! fill allowances, the fill audit and the sites where a purchase needs no
//! final approval card. Additive `IF NOT EXISTS` only.
use rusqlite::Connection;

use super::super::AppStorageError;

pub(super) fn create(connection: &Connection) -> Result<(), AppStorageError> {
    migrate(connection)?;
    connection
        .execute_batch(VAULT_SCHEMA)
        .map_err(AppStorageError::sqlite)
}

const VAULT_SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS browser_payment_cards (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  brand TEXT NOT NULL,
  last4 TEXT NOT NULL,
  exp_month INTEGER NOT NULL,
  exp_year INTEGER NOT NULL,
  holder_name TEXT NOT NULL DEFAULT '',
  billing_json TEXT NOT NULL DEFAULT '{}',
  extras_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS browser_autofill_profiles (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  extras_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS browser_vault_sites (
  kind TEXT NOT NULL CHECK (kind IN ('card', 'profile')),
  item_id TEXT NOT NULL,
  site TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, item_id, site)
);
CREATE TABLE IF NOT EXISTS browser_vault_audit (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  frame_origin TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_vault_audit_item_idx ON browser_vault_audit(kind, item_id, id DESC);
CREATE TABLE IF NOT EXISTS browser_purchase_sites (
  site TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
";

/// Rename legacy metadata and allowances atomically on the storage owner lane.
fn migrate(db: &Connection) -> Result<(), AppStorageError> {
    let old: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_traveler_profiles')",
        [], |row| row.get(0),
    ).map_err(AppStorageError::sqlite)?;
    if !old {
        return Ok(());
    }
    let new: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_autofill_profiles')",
        [], |row| row.get(0),
    ).map_err(AppStorageError::sqlite)?;
    db.execute_batch("SAVEPOINT autofill_upgrade;")
        .map_err(AppStorageError::sqlite)?;
    let result = (|| {
        db.execute_batch(if new {
            "INSERT INTO browser_autofill_profiles
              (id,nickname,details_json,extras_json,created_at,last_used_at)
             SELECT id,nickname,details_json,extras_json,created_at,last_used_at
             FROM browser_traveler_profiles WHERE id NOT IN
              (SELECT id FROM browser_autofill_profiles);
             DROP TABLE browser_traveler_profiles;"
        } else {
            "ALTER TABLE browser_traveler_profiles RENAME TO browser_autofill_profiles;"
        })?;
        db.execute_batch(
            "ALTER TABLE browser_vault_sites RENAME TO browser_vault_sites_legacy;
            CREATE TABLE browser_vault_sites (
              kind TEXT NOT NULL CHECK(kind IN ('card','profile')), item_id TEXT NOT NULL,
              site TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(kind,item_id,site));
            INSERT OR IGNORE INTO browser_vault_sites
              SELECT CASE kind WHEN 'traveler' THEN 'profile' ELSE kind END,
              item_id,site,created_at FROM browser_vault_sites_legacy ORDER BY kind;
            DROP TABLE browser_vault_sites_legacy;
            UPDATE browser_vault_audit SET kind='profile' WHERE kind='traveler';
            RELEASE autofill_upgrade;",
        )
    })();
    if result.is_err() {
        let rollback = db.execute_batch("ROLLBACK TO autofill_upgrade;");
        let release = db.execute_batch("RELEASE autofill_upgrade;");
        rollback.and(release).map_err(AppStorageError::sqlite)?;
    }
    result.map_err(AppStorageError::sqlite)
}
