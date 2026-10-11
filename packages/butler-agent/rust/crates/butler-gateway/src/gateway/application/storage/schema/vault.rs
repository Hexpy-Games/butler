//! Payment vault and traveler profiles (no secrets: card numbers, CVCs and
//! identity numbers live only in the OS credential store), their per-site
//! fill allowances, the fill audit and the sites where a purchase needs no
//! final approval card. Additive `IF NOT EXISTS` only.
use rusqlite::Connection;

use super::super::AppStorageError;

pub(super) fn create(connection: &Connection) -> Result<(), AppStorageError> {
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
CREATE TABLE IF NOT EXISTS browser_traveler_profiles (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  extras_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS browser_vault_sites (
  kind TEXT NOT NULL CHECK (kind IN ('card', 'traveler')),
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
